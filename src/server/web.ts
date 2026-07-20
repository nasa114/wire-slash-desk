import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { Repositories } from '../domain/repositories.ts';
import type { Article, Feed, NewFeed, User } from '../domain/types.ts';
import { DuplicateFeedUrlError, NotFoundError } from '../domain/errors.ts';
import { getConnInfo } from '@hono/node-server/conninfo';
import { isPrivateIpLiteral } from './ssrf.ts';
import { timingSafeEqualStr } from './auth.ts';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './password.ts';
import { LoginThrottle } from './login-throttle.ts';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME, SESSION_TTL_MS } from './session.ts';
import { OAUTH_SCOPES, type RssOAuthProvider } from './oauth-provider.ts';
import type { BuildInfo } from './build-info.ts';
import { minifyCss, minifyHtml, minifyJs } from './minify.ts';
import {
  articlesBody,
  authLayout,
  consentBody,
  consentErrorBody,
  dashboardBody,
  feedEditBody,
  feedsBody,
  isRealDate,
  jstDayStamp,
  layout,
  loginBody,
  messagePage,
  setupBody,
  UUID_RE,
  type FeedFormValues,
  type PageContext,
} from './views.ts';

/**
 * ブラウザ向け Web UI(T4-1 管理UI最小版)。設計方針:
 * - 認証: users テーブル + scrypt、セッション Cookie(HttpOnly / SameSite=Lax)
 * - CSRF: Origin 検証(hono/csrf)。フォームはすべて同一オリジンの POST
 * - すべてのフォームは POST → 303 リダイレクト(PRG)。HTMX(hx-boost)は漸進的強化
 */
export interface WebDeps {
  repos: Repositories;
  /** Set-Cookie に Secure を付けるか(TLS 終端配下では true にする)。 */
  cookieSecure: boolean;
  now?: () => Date;
  /** ログイン総当たり対策。既定は既定パラメータの LoginThrottle(now を共有)。テストで注入可。 */
  loginThrottle?: LoginThrottle;
  /** 送信元 IP の取得(既定は TCP 接続元。X-Forwarded-For は既定で信頼しない)。テストで注入可。 */
  clientIp?: (c: Context<WebEnv>) => string;
  /** MCP OAuth 2.1 の同意画面を有効にする(T4-2)。未指定なら OAuth 無効。 */
  oauthProvider?: RssOAuthProvider;
  /** 初回セットアップを保護する任意トークン(PT-001)。未指定なら従来どおり無保護。 */
  setupToken?: string;
  /** バージョン・ビルド情報。指定時は認証済みページのフッターに表示する。 */
  buildInfo?: BuildInfo;
}

type WebEnv = { Variables: { user: User } };

const require = createRequire(import.meta.url);
let htmxSource: string | null = null;
function loadHtmxSource(): string {
  if (htmxSource === null) {
    htmxSource = readFileSync(require.resolve('htmx.org/dist/htmx.min.js'), 'utf8');
  }
  return htmxSource;
}

/** src/server/assets/ の静的ファイル(共通CSS・ログイン画面の背景SVG・アラートJS・時計JS)。 */
const assetCache = new Map<string, string>();
function loadAsset(name: string): string {
  let content = assetCache.get(name);
  if (content === undefined) {
    content = readFileSync(new URL(`./assets/${name}`, import.meta.url), 'utf8');
    // 配信前に minify(実装コメント等の情報露出低減。src/server/minify.ts 参照)。
    // ソースはコメント付きのまま保ち、初回ロード時に1回だけ変換してキャッシュする。
    if (name.endsWith('.css')) content = minifyCss(content);
    else if (name.endsWith('.js')) content = minifyJs(content);
    assetCache.set(name, content);
  }
  return content;
}

/* ----------------------------------------------------------- data access */

/**
 * JST の1日(00:00〜24:00 JST)に公開された記事を取得する。
 * リポジトリの listByDate は UTC 日付単位のため、JST の1日がまたぐ
 * 2つの UTC 日を取得し、JST 日付で絞り込む。
 */
async function listByJstDate(repos: Repositories, jstDate: string): Promise<Article[]> {
  const dayStartUtc = new Date(`${jstDate}T00:00:00.000Z`);
  const prevUtcDay = new Date(dayStartUtc.getTime() - 24 * 60 * 60_000).toISOString().slice(0, 10);
  const [prev, same] = await Promise.all([
    repos.articles.listByDate(prevUtcDay),
    repos.articles.listByDate(jstDate),
  ]);
  const seen = new Set<string>();
  return [...prev, ...same]
    .filter((a) => {
      if (a.publishedAt === null) return false;
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return jstDayStamp(a.publishedAt) === jstDate;
    })
    .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
}

/** 指定カテゴリのフィードの記事だけに絞る(visibleArticles と同じフィルタ方式)。 */
function filterByCategory(articles: Article[], feeds: Feed[], category: string): Article[] {
  if (category === '') return articles;
  const ids = new Set(feeds.filter((f) => f.category === category).map((f) => f.id));
  return articles.filter((a) => ids.has(a.feedId));
}

async function queryArticles(
  repos: Repositories,
  filter: { q: string; date: string; feedId: string },
): Promise<Article[]> {
  let articles: Article[];
  if (filter.q !== '') {
    articles = await repos.articles.searchByTitle(
      filter.q,
      filter.feedId !== '' ? { limit: 200, feedId: filter.feedId } : { limit: 200 },
    );
  } else if (filter.date !== '') {
    articles = await listByJstDate(repos, filter.date);
  } else {
    articles = await repos.articles.listRecent(
      filter.feedId !== '' ? { feedId: filter.feedId, limit: 200 } : { limit: 200 },
    );
  }
  if (filter.feedId !== '') {
    articles = articles.filter((a) => a.feedId === filter.feedId);
  }
  return articles;
}

/**
 * 無効化(enabled=false)したフィードの記事をトップ・記事一覧から隠す。
 * データは削除せず表示だけを抑止するので、再有効化すれば元に戻る。
 * レールの「フィードの状態」や enabled/total 統計は状態表示が目的のため対象外。
 */
function visibleArticles(articles: Article[], feeds: Feed[]): Article[] {
  const enabledIds = new Set(feeds.filter((f) => f.enabled).map((f) => f.id));
  return articles.filter((a) => enabledIds.has(a.feedId));
}

/* ------------------------------------------------------- form validation */

const MAX_URL_LEN = 2048;
const MAX_CATEGORY_LEN = 100;
const MIN_INTERVAL = 15;
const MAX_INTERVAL = 31 * 24 * 60; // 31日。事実上の上限(異常値の混入防止)。

function formStr(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** http/https のみ許可した URL 検証(フィード由来 URL と同じ方針)。 */
function validHttpUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // プライベート/予約 IP のリテラル直指定は登録時点で拒否する(SSRF の入口を塞ぐ)。
  // ホスト名の解決先チェックは取得時の SSRF ガードと egress プロキシに委ねる。
  if (isPrivateIpLiteral(parsed.hostname)) return false;
  return true;
}

type FeedFormParse =
  | { ok: true; input: NewFeed; values: FeedFormValues }
  | { ok: false; error: string; values: FeedFormValues };

function parseFeedForm(body: Record<string, unknown>): FeedFormParse {
  const values: FeedFormValues = {
    name: formStr(body, 'name'),
    feedUrl: formStr(body, 'feed_url'),
    siteUrl: formStr(body, 'site_url'),
    fetchIntervalMinutes: formStr(body, 'fetch_interval_minutes'),
    translate: body['translate'] !== undefined,
    fulltextAllowed: body['fulltext_allowed'] !== undefined,
    enabled: body['enabled'] !== undefined,
    tosNote: formStr(body, 'tos_note'),
    category: formStr(body, 'category'),
  };
  const fail = (error: string): FeedFormParse => ({ ok: false, error, values });

  if (values.name === '' || values.name.length > 200) {
    return fail('名前は1〜200文字で入力してください。');
  }
  if (values.feedUrl.length > MAX_URL_LEN || !validHttpUrl(values.feedUrl)) {
    return fail('フィードURLは http:// または https:// の有効なURLを入力してください。');
  }
  if (values.siteUrl !== '' && (values.siteUrl.length > MAX_URL_LEN || !validHttpUrl(values.siteUrl))) {
    return fail('サイトURLは http:// または https:// の有効なURLを入力してください。');
  }
  if (!/^\d+$/.test(values.fetchIntervalMinutes)) {
    return fail('取得間隔は分単位の整数で入力してください。');
  }
  const interval = Number(values.fetchIntervalMinutes);
  if (interval < MIN_INTERVAL || interval > MAX_INTERVAL) {
    return fail(`取得間隔は${MIN_INTERVAL}〜${MAX_INTERVAL}分の範囲で入力してください。`);
  }
  if (values.tosNote.length > 2000) {
    return fail('規約メモは2000文字以内で入力してください。');
  }
  if (values.category.length > MAX_CATEGORY_LEN) {
    return fail(`カテゴリは${MAX_CATEGORY_LEN}文字以内で入力してください。`);
  }
  return {
    ok: true,
    values,
    input: {
      name: values.name,
      feedUrl: values.feedUrl,
      siteUrl: values.siteUrl === '' ? null : values.siteUrl,
      fetchIntervalMinutes: interval,
      translate: values.translate,
      fulltextAllowed: values.fulltextAllowed,
      enabled: values.enabled,
      tosNote: values.tosNote === '' ? null : values.tosNote,
      category: values.category === '' ? null : values.category,
    },
  };
}

const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 200;

/**
 * ログイン後リダイレクト(next)の許可判定。オープンリダイレクト対策として
 * 同一オリジンの絶対パスのみ許可する(`//evil.example` やバックスラッシュ・
 * 制御文字入りは拒否)。許可できない値は null。
 */
const SAFE_NEXT_RE = /^\/[\x21-\x7e]*$/;
function safeNext(value: string | undefined): string | null {
  if (value === undefined || value === '' || value.length > 512) return null;
  if (!SAFE_NEXT_RE.test(value) || value.startsWith('//') || value.includes('\\')) return null;
  return value;
}

/* --------------------------------------------------------------- app */

export function createWebApp(deps: WebDeps): Hono<WebEnv> {
  const now = deps.now ?? (() => new Date());
  const app = new Hono<WebEnv>();

  // ログイン総当たり対策(設計書 §7 / KnownLimitations §7)。now を共有して
  // テストの決定的クロックに追従させる。
  const loginThrottle = deps.loginThrottle ?? new LoginThrottle({ now: () => now().getTime() });
  const clientIp =
    deps.clientIp ??
    ((c: Context<WebEnv>): string => {
      // 送信元 IP は TCP 接続元のみを使う。X-Forwarded-For はスプーフ可能なため
      // 既定で信頼しない(信頼できるリバースプロキシ配下ではそちらでの制限を推奨)。
      try {
        return getConnInfo(c).remote.address ?? 'unknown';
      } catch {
        return 'unknown';
      }
    });
  /** ログイン絞りのキー: 正規化ユーザー名(あれば)+ 送信元 IP。 */
  const throttleKeys = (c: Context<WebEnv>, username: string): string[] => {
    const keys = [`ip:${clientIp(c)}`];
    if (username !== '') keys.push(`u:${username.toLowerCase()}`);
    return keys;
  };

  const html = (c: Context, body: string, status = 200): Response => {
    c.header('cache-control', 'no-store');
    // 全 HTML レスポンス共通の出口で minify(実装コメント等の情報露出低減。src/server/minify.ts 参照)。
    return c.html(minifyHtml(body), status as 200);
  };

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // スタイルは /assets/app.css のみ(インライン style / <style> は不使用)。
        styleSrc: ["'self'"],
        imgSrc: ["'self'"],
        connectSrc: ["'self'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
  );

  // 認証前エンドポイント(/login, /setup)への巨大ボディによるメモリ圧迫を防ぐ。
  // フォームは数KBで足りるため 64KB(/internal/collect と同じ水準)。
  app.use('*', bodyLimit({ maxSize: 64 * 1024 }));

  // CSRF: Origin ヘッダのホストがリクエストの Host と一致する場合のみ非GETを許可。
  // (スキーム比較にしないのは TLS 終端プロキシ配下で Origin が https、内部が http になるため)
  app.use(
    '*',
    csrf({
      origin: (origin, c) => {
        try {
          return new URL(origin).host === c.req.header('host');
        } catch {
          return false;
        }
      },
    }),
  );

  /* ------------------------------------------------ session helpers */

  const resolveUser = async (c: Context<WebEnv>): Promise<User | null> => {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    if (token === undefined || token === '') return null;
    const session = await deps.repos.sessions.getByTokenHash(hashSessionToken(token));
    if (session === null) return null;
    if (session.expiresAt.getTime() <= now().getTime()) {
      await deps.repos.sessions.deleteByTokenHash(session.tokenHash);
      return null;
    }
    return deps.repos.users.getById(session.userId);
  };

  const requireAuth = async (c: Context<WebEnv>, next: () => Promise<void>): Promise<Response | void> => {
    const user = await resolveUser(c);
    if (user === null) {
      if (c.req.method === 'GET') return c.redirect('/login', 302);
      return c.text('unauthorized', 401);
    }
    c.set('user', user);
    await next();
  };

  const pageCtx = (c: Context<WebEnv>, activeNav: PageContext['activeNav'], query?: { q: string; date: string }): PageContext => ({
    now: now(),
    activeNav,
    username: c.get('user').username,
    ...(query !== undefined ? { query } : {}),
    ...(deps.buildInfo !== undefined ? { buildInfo: deps.buildInfo } : {}),
  });

  /* ------------------------------------------------------ assets */

  app.get('/assets/htmx.min.js', (c) => {
    c.header('cache-control', 'public, max-age=86400');
    c.header('content-type', 'text/javascript; charset=utf-8');
    return c.body(loadHtmxSource());
  });

  app.get('/assets/app.css', (c) => {
    c.header('cache-control', 'public, max-age=86400');
    c.header('content-type', 'text/css; charset=utf-8');
    return c.body(loadAsset('app.css'));
  });

  app.get('/assets/clock.js', (c) => {
    c.header('cache-control', 'public, max-age=86400');
    c.header('content-type', 'text/javascript; charset=utf-8');
    return c.body(loadAsset('clock.js'));
  });

  app.get('/assets/login.js', (c) => {
    c.header('cache-control', 'public, max-age=86400');
    c.header('content-type', 'text/javascript; charset=utf-8');
    return c.body(loadAsset('login.js'));
  });

  app.get('/assets/login-bg.svg', (c) => {
    c.header('cache-control', 'public, max-age=86400');
    c.header('content-type', 'image/svg+xml; charset=utf-8');
    return c.body(loadAsset('login-bg.svg'));
  });

  /* ------------------------------------------- setup(初回のみ開放) */

  // PT-001: SETUP_TOKEN が設定されていれば、初回セットアップにトークン一致を必須にする。
  const setupTokenRequired = deps.setupToken !== undefined && deps.setupToken !== '';
  const setupTokenOk = (provided: string): boolean =>
    !setupTokenRequired || timingSafeEqualStr(provided, deps.setupToken as string);

  app.get('/setup', async (c) => {
    if ((await deps.repos.users.count()) > 0) return c.redirect('/login', 302);
    return html(c, authLayout('初回セットアップ — Wire Desk', setupBody({ tokenRequired: setupTokenRequired })));
  });

  app.post('/setup', async (c) => {
    // 早期の open 判定(UX 用)。実際の作成は createInitial が原子的に行うため、
    // ここを通り抜けても二重作成は起きない(PT-001)。
    if ((await deps.repos.users.count()) > 0) {
      return c.text('setup already completed', 403);
    }
    const body = await c.req.parseBody();
    const username = formStr(body, 'username');
    const password = typeof body['password'] === 'string' ? body['password'] : '';
    const confirm = typeof body['password_confirm'] === 'string' ? body['password_confirm'] : '';
    const setupTokenInput = formStr(body, 'setup_token');
    const fail = (error: string): Response =>
      html(
        c,
        authLayout('初回セットアップ — Wire Desk', setupBody({ error, username, tokenRequired: setupTokenRequired })),
        400,
      );

    // トークン保護時: 不一致は作成せず 403(理由は絞り、入力値も残さない)。
    if (!setupTokenOk(setupTokenInput)) {
      return html(
        c,
        authLayout(
          '初回セットアップ — Wire Desk',
          setupBody({ error: 'セットアップトークンが正しくありません。', tokenRequired: setupTokenRequired }),
        ),
        403,
      );
    }
    if (!USERNAME_RE.test(username)) {
      return fail('ユーザー名は英数と ._- のみ・64文字以内で入力してください。');
    }
    if (password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN) {
      return fail(`パスワードは${MIN_PASSWORD_LEN}文字以上${MAX_PASSWORD_LEN}文字以内で入力してください。`);
    }
    if (password !== confirm) {
      return fail('確認用パスワードが一致しません。');
    }
    // 原子的 first-run 作成: 既にユーザーがいれば null(並行 POST でも1件のみ成立)。
    const created = await deps.repos.users.createInitial({
      username,
      passwordHash: await hashPassword(password),
    });
    if (created === null) {
      return c.text('setup already completed', 403);
    }
    return c.redirect('/login?created=1', 303);
  });

  /* ---------------------------------------------------- login/logout */

  app.get('/login', async (c) => {
    if ((await deps.repos.users.count()) === 0) return c.redirect('/setup', 302);
    if ((await resolveUser(c)) !== null) return c.redirect('/', 302);
    const notice = c.req.query('created') === '1' ? '管理ユーザーを作成しました。ログインしてください。' : undefined;
    const next = safeNext(c.req.query('next'));
    return html(
      c,
      authLayout(
        'ログイン — Wire Desk',
        loginBody({
          ...(notice !== undefined ? { notice } : {}),
          ...(next !== null ? { next } : {}),
        }),
        { login: true },
      ),
    );
  });

  app.post('/login', async (c) => {
    const body = await c.req.parseBody();
    const username = formStr(body, 'username');
    const password = typeof body['password'] === 'string' ? body['password'] : '';
    const next = safeNext(formStr(body, 'next'));
    const keys = throttleKeys(c, username);

    // 総当たり対策: 閾値到達なら scrypt 検証すら行わず 429 を返す
    // (辞書攻撃の抑制と、scrypt による CPU/worker pool 枯渇 DoS の緩和を兼ねる)。
    const decision = loginThrottle.check(keys);
    if (decision.limited) {
      c.header('Retry-After', String(decision.retryAfterSec));
      return html(
        c,
        authLayout(
          'ログイン — Wire Desk',
          loginBody({
            error: '試行回数が多すぎます。しばらく時間をおいて再度お試しください。',
            ...(next !== null ? { next } : {}),
          }),
          { login: true },
        ),
        429,
      );
    }

    const user = username !== '' ? await deps.repos.users.getByUsername(username) : null;
    // ユーザー不在でもダミーハッシュを検証し、応答時間からの存在推測を防ぐ。
    const ok =
      password !== '' &&
      password.length <= MAX_PASSWORD_LEN &&
      (await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH)) &&
      user !== null;

    if (!ok) {
      loginThrottle.recordFailure(keys);
      // 文言はユーザー名/パスワードのどちらが誤りかを判別できないものに固定する(列挙対策)。
      return html(
        c,
        authLayout(
          'ログイン — Wire Desk',
          loginBody({
            error: 'ユーザー名またはパスワードが正しくありません。',
            ...(next !== null ? { next } : {}),
          }),
          { login: true },
        ),
        401,
      );
    }

    // 認証成功: このキーの失敗履歴を解除する。
    loginThrottle.reset(keys);

    // ついでに期限切れセッションを掃除(専用バッチを持たない運用)。
    await deps.repos.sessions.deleteExpired(now());

    const { token, tokenHash } = generateSessionToken();
    await deps.repos.sessions.create({
      userId: user.id,
      tokenHash,
      expiresAt: new Date(now().getTime() + SESSION_TTL_MS),
    });
    setCookie(c, SESSION_COOKIE_NAME, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: deps.cookieSecure,
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return c.redirect(next ?? '/', 303);
  });

  app.post('/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    if (token !== undefined && token !== '') {
      await deps.repos.sessions.deleteByTokenHash(hashSessionToken(token));
    }
    deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
    return c.redirect('/login', 303);
  });

  /* ------------------------------------- MCP OAuth 同意画面(T4-2) */

  const oauthProvider = deps.oauthProvider;
  if (oauthProvider !== undefined) {
    // /authorize(SDK ハンドラ)が発行する request id の形式(base64url 16 バイト)。
    const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
    const consentError = (c: Context<WebEnv>): Response =>
      html(c, authLayout('認可エラー — Wire Desk', consentErrorBody()), 400);

    app.get('/oauth/consent', async (c) => {
      const requestId = c.req.query('request') ?? '';
      if (!REQUEST_ID_RE.test(requestId)) return consentError(c);
      const user = await resolveUser(c);
      if (user === null) {
        // 未ログインならログイン後にこの同意画面へ戻す。
        const next = `/oauth/consent?request=${encodeURIComponent(requestId)}`;
        return c.redirect(`/login?next=${encodeURIComponent(next)}`, 302);
      }
      const pending = oauthProvider.peekPendingAuthorization(requestId);
      if (pending === null) return consentError(c);
      const clientName =
        typeof pending.client.client_name === 'string' && pending.client.client_name !== ''
          ? pending.client.client_name
          : pending.client.client_id;
      return html(
        c,
        authLayout(
          'MCP クライアントの接続許可 — Wire Desk',
          consentBody({
            requestId,
            clientName,
            redirectUri: pending.params.redirectUri,
            scopes: OAUTH_SCOPES,
            username: user.username,
          }),
        ),
      );
    });

    app.post('/oauth/consent', async (c) => {
      const user = await resolveUser(c);
      if (user === null) return c.text('unauthorized', 401);
      const body = await c.req.parseBody();
      const requestId = formStr(body, 'request');
      const action = formStr(body, 'action');
      if (!REQUEST_ID_RE.test(requestId) || (action !== 'approve' && action !== 'deny')) {
        return consentError(c);
      }
      const result = await oauthProvider.completeAuthorization(
        requestId,
        user.id,
        action === 'approve',
      );
      if (result === null) return consentError(c);
      // 承認/拒否の結果はクライアントの redirect_uri へ返す(コード or access_denied)。
      return c.redirect(result.redirectTo, 303);
    });
  }

  /* ------------------------------------------------- 旧 /ui 互換 */

  app.get('/ui', (c) => c.redirect(`/${new URL(c.req.url).search}`, 301));
  app.get('/ui/articles', (c) => c.redirect(`/articles${new URL(c.req.url).search}`, 301));
  app.get('/ui/feeds', (c) => c.redirect(`/feeds${new URL(c.req.url).search}`, 301));

  /* --------------------------------------------------- 認証必須ページ */

  app.use('/', requireAuth);
  app.use('/articles', requireAuth);
  app.use('/feeds', requireAuth);
  app.use('/feeds/*', requireAuth);

  app.get('/', async (c) => {
    // 検索フォーム互換: クエリ付きで / に来たら記事一覧へ。
    const search = new URL(c.req.url).search;
    if (c.req.query('q') !== undefined || c.req.query('date') !== undefined || c.req.query('feed') !== undefined) {
      return c.redirect(`/articles${search}`, 302);
    }
    const current = now();
    const since = new Date(current.getTime() - 24 * 60 * 60_000);
    const [feeds, last24] = await Promise.all([
      deps.repos.feeds.list(),
      deps.repos.articles.listRecent({ since, limit: 200 }),
    ]);
    const ctx = pageCtx(c, 'dashboard', { q: '', date: '' });
    return html(
      c,
      layout(
        'Wire Desk — パーソナルRSSリーダー',
        ctx,
        dashboardBody({ last24: visibleArticles(last24, feeds), feeds }),
      ),
    );
  });

  app.get('/articles', async (c) => {
    const q = c.req.query('q')?.trim() ?? '';
    const date = c.req.query('date')?.trim() ?? '';
    const feedId = c.req.query('feed')?.trim() ?? '';
    const category = c.req.query('category')?.trim() ?? '';
    const ctx = pageCtx(c, 'articles', { q, date });
    if (date !== '' && !isRealDate(date)) {
      return html(c, messagePage(ctx, '不正なリクエスト', 'date は実在する日付を YYYY-MM-DD 形式で指定してください。'), 400);
    }
    if (feedId !== '' && !UUID_RE.test(feedId)) {
      return html(c, messagePage(ctx, '不正なリクエスト', 'feed の形式が不正です。'), 400);
    }
    if (category.length > MAX_CATEGORY_LEN) {
      return html(c, messagePage(ctx, '不正なリクエスト', `category は${MAX_CATEGORY_LEN}文字以内で指定してください。`), 400);
    }
    const [feeds, articles] = await Promise.all([
      deps.repos.feeds.list(),
      queryArticles(deps.repos, { q, date, feedId }),
    ]);
    return html(
      c,
      layout(
        '記事一覧 — Wire Desk',
        ctx,
        articlesBody({
          articles: filterByCategory(visibleArticles(articles, feeds), feeds, category),
          feeds,
          q,
          date,
          feedId,
          category,
        }),
      ),
    );
  });

  /* ------------------------------------------------ feeds CRUD(T4-1) */

  app.get('/feeds', async (c) => {
    const feeds = await deps.repos.feeds.list();
    const ctx = pageCtx(c, 'feeds');
    const notice = c.req.query('saved') === '1' ? '保存しました。' : undefined;
    return html(c, layout('フィード管理 — Wire Desk', ctx, feedsBody({ feeds, ...(notice !== undefined ? { notice } : {}) })));
  });

  app.post('/feeds', async (c) => {
    const parsed = parseFeedForm(await c.req.parseBody());
    const renderError = async (error: string, status: number): Promise<Response> => {
      const feeds = await deps.repos.feeds.list();
      return html(c, layout('フィード管理 — Wire Desk', pageCtx(c, 'feeds'), feedsBody({ feeds, error, form: parsed.values })), status);
    };
    if (!parsed.ok) return renderError(parsed.error, 400);
    try {
      await deps.repos.feeds.create(parsed.input);
    } catch (err) {
      if (err instanceof DuplicateFeedUrlError) {
        return renderError('このフィードURLはすでに登録されています。', 409);
      }
      throw err;
    }
    return c.redirect('/feeds?saved=1', 303);
  });

  /** :id 共通の前処理。不正 UUID・不存在は null を返し、呼び出し側で 404 にする。 */
  const findFeed = async (c: Context<WebEnv>) => {
    const id = c.req.param('id');
    if (id === undefined || !UUID_RE.test(id)) return null;
    return deps.repos.feeds.getById(id);
  };

  const notFoundPage = (c: Context<WebEnv>): Response =>
    html(c, messagePage(pageCtx(c, 'feeds'), 'フィードが見つかりません', '削除済みか、URLが誤っています。'), 404);

  app.get('/feeds/:id', async (c) => {
    const feed = await findFeed(c);
    if (feed === null) return notFoundPage(c);
    // datalist 用の既存カテゴリ候補(全フィードから抽出はビュー側)。
    const feeds = await deps.repos.feeds.list();
    const categories = [...new Set(feeds.flatMap((f) => (f.category !== null ? [f.category] : [])))];
    return html(c, layout('フィードを編集 — Wire Desk', pageCtx(c, 'feeds'), feedEditBody({ feed, categories })));
  });

  app.post('/feeds/:id', async (c) => {
    const feed = await findFeed(c);
    if (feed === null) return notFoundPage(c);
    const parsed = parseFeedForm(await c.req.parseBody());
    const renderError = (error: string, status: number): Response =>
      html(c, layout('フィードを編集 — Wire Desk', pageCtx(c, 'feeds'), feedEditBody({ feed, error, form: parsed.values })), status);
    if (!parsed.ok) return renderError(parsed.error, 400);
    try {
      await deps.repos.feeds.update(feed.id, parsed.input);
    } catch (err) {
      if (err instanceof DuplicateFeedUrlError) {
        return renderError('このフィードURLはすでに別のフィードで登録されています。', 409);
      }
      throw err;
    }
    return c.redirect('/feeds?saved=1', 303);
  });

  app.post('/feeds/:id/toggle', async (c) => {
    const feed = await findFeed(c);
    if (feed === null) return notFoundPage(c);
    await deps.repos.feeds.update(feed.id, { enabled: !feed.enabled });
    return c.redirect('/feeds', 303);
  });

  app.post('/feeds/:id/delete', async (c) => {
    const feed = await findFeed(c);
    if (feed === null) return notFoundPage(c);
    try {
      await deps.repos.feeds.delete(feed.id);
    } catch (err) {
      if (err instanceof NotFoundError) return notFoundPage(c);
      throw err;
    }
    return c.redirect('/feeds', 303);
  });

  /* ------------------------------------------------------- fallback */

  app.notFound((c) =>
    html(
      c,
      authLayout(
        'ページが見つかりません — Wire Desk',
        `<p style="font-size:0.9rem;color:var(--ink-2)">ページが見つかりません。</p><p style="font-size:0.86rem"><a href="/">ダッシュボードへ戻る →</a></p>`,
      ),
      404,
    ),
  );

  app.onError((err, c) => {
    // CSRF(403)など、ミドルウェアが意図して投げた HTTP 例外はそのまま返す。
    if (err instanceof HTTPException) return err.getResponse();
    // 内部情報(スタック・SQL等)はブラウザに出さない。
    console.error('web ui error:', err instanceof Error ? err.message : err);
    return html(
      c,
      authLayout('エラー — Wire Desk', `<p style="font-size:0.9rem;color:var(--danger)">内部エラーが発生しました。</p>`),
      500,
    );
  });

  return app;
}
