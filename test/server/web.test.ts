import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../src/server/app.ts';
import { createMemoryRepositories } from '../../src/repo/memory/index.ts';
import type { Repositories } from '../../src/domain/repositories.ts';

const ADMIN_USER = 'admin';
const ADMIN_PASSWORD = 'test-password-123';

interface TestApp {
  repos: Repositories;
  base: string;
  clock: { current: Date };
  close: () => Promise<void>;
}

async function startApp(): Promise<TestApp> {
  const repos = createMemoryRepositories();
  const clock = { current: new Date() };
  const app: Server = createApp({
    repos,
    runCollect: async () => ({}),
    mcpBearerToken: 'mcp-token',
    collectorToken: 'collector-token',
    cacheFulltext: false,
    now: () => clock.current,
  });
  await new Promise<void>((resolve) => app.listen(0, resolve));
  const { port } = app.address() as AddressInfo;
  return {
    repos,
    clock,
    base: `http://localhost:${port}`,
    close: () => new Promise((resolve) => app.close(() => resolve())),
  };
}

/** フォーム POST(同一オリジンの Origin ヘッダ付き。CSRF ミドルウェアを通すため必須)。 */
function postForm(
  base: string,
  path: string,
  body: Record<string, string>,
  opts: { cookie?: string; origin?: string } = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: opts.origin ?? base,
      ...(opts.cookie !== undefined ? { cookie: opts.cookie } : {}),
    },
    body: new URLSearchParams(body).toString(),
  });
}

function getPage(base: string, path: string, cookie?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    redirect: 'manual',
    ...(cookie !== undefined ? { headers: { cookie } } : {}),
  });
}

async function setupAdmin(base: string): Promise<void> {
  const res = await postForm(base, '/setup', {
    username: ADMIN_USER,
    password: ADMIN_PASSWORD,
    password_confirm: ADMIN_PASSWORD,
  });
  assert.equal(res.status, 303, 'setup は成功すること');
}

/** ログインしてセッション Cookie(`session=...`)を返す。 */
async function login(base: string, username = ADMIN_USER, password = ADMIN_PASSWORD): Promise<string> {
  const res = await postForm(base, '/login', { username, password });
  assert.equal(res.status, 303, 'login は成功すること');
  const setCookie = res.headers.getSetCookie().find((v) => v.startsWith('session='));
  assert.ok(setCookie, 'Set-Cookie: session が返ること');
  return setCookie.split(';', 1)[0] as string;
}

async function startLoggedIn(): Promise<TestApp & { cookie: string }> {
  const app = await startApp();
  await setupAdmin(app.base);
  const cookie = await login(app.base);
  return { ...app, cookie };
}

async function seed(repos: Repositories): Promise<void> {
  const feed = await repos.feeds.create({ name: 'Feed <One>', feedUrl: 'https://one.example.com/rss' });
  await repos.articles.upsertMany([
    {
      feedId: feed.id,
      guid: 'g1',
      title: 'PostgreSQL 17 Released',
      url: 'https://one.example.com/pg17',
      publishedAt: new Date('2026-07-15T10:00:00Z'),
    },
    {
      feedId: feed.id,
      guid: 'g2',
      title: '<script>alert(1)</script> injection attempt',
      url: 'https://one.example.com/xss',
      publishedAt: new Date('2026-07-14T10:00:00Z'),
    },
  ]);
}

/* ------------------------------------------------------ 認証・セッション */

test('auth: 未ログインの保護ページは /login へリダイレクト', async () => {
  const { base, close } = await startApp();
  try {
    await setupAdmin(base);
    for (const path of ['/', '/articles', '/feeds']) {
      const res = await getPage(base, path);
      assert.equal(res.status, 302, `${path} は 302`);
      assert.equal(res.headers.get('location'), '/login');
    }
    // 非GETの保護エンドポイントは 401
    const post = await postForm(base, '/feeds', { name: 'x' });
    assert.equal(post.status, 401);
  } finally {
    await close();
  }
});

test('auth: ユーザー0件なら /login は /setup へ誘導し、setup 完了後は /setup を閉じる', async () => {
  const { base, close } = await startApp();
  try {
    const loginRes = await getPage(base, '/login');
    assert.equal(loginRes.status, 302);
    assert.equal(loginRes.headers.get('location'), '/setup');
    const setupPage = await getPage(base, '/setup');
    assert.equal(setupPage.status, 200);
    assert.match(await setupPage.text(), /初回セットアップ/);

    await setupAdmin(base);

    const setupAfter = await getPage(base, '/setup');
    assert.equal(setupAfter.status, 302, 'setup 済みなら /login へ');
    const setupPost = await postForm(base, '/setup', {
      username: 'evil',
      password: 'x'.repeat(12),
      password_confirm: 'x'.repeat(12),
    });
    assert.equal(setupPost.status, 403, '2人目は作成できない(fail closed)');
  } finally {
    await close();
  }
});

test('auth: setup の入力バリデーション(短いパスワード・不一致・不正ユーザー名)', async () => {
  const { base, close } = await startApp();
  try {
    const short = await postForm(base, '/setup', {
      username: 'admin',
      password: 'short',
      password_confirm: 'short',
    });
    assert.equal(short.status, 400);
    const mismatch = await postForm(base, '/setup', {
      username: 'admin',
      password: 'long-enough-password',
      password_confirm: 'different-password!!',
    });
    assert.equal(mismatch.status, 400);
    const badName = await postForm(base, '/setup', {
      username: 'no spaces allowed',
      password: 'long-enough-password',
      password_confirm: 'long-enough-password',
    });
    assert.equal(badName.status, 400);
    // どれも作成されていない
    assert.equal(await getPage(base, '/setup').then((r) => r.status), 200);
  } finally {
    await close();
  }
});

test('auth: 誤パスワード・未知ユーザーは 401、正しい資格情報でセッション Cookie が発行される', async () => {
  const { base, close } = await startApp();
  try {
    await setupAdmin(base);
    const wrong = await postForm(base, '/login', { username: ADMIN_USER, password: 'wrong-password' });
    assert.equal(wrong.status, 401);
    const unknown = await postForm(base, '/login', { username: 'nobody', password: ADMIN_PASSWORD });
    assert.equal(unknown.status, 401);

    const ok = await postForm(base, '/login', { username: ADMIN_USER, password: ADMIN_PASSWORD });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), '/');
    const setCookie = ok.headers.getSetCookie().find((v) => v.startsWith('session=')) ?? '';
    assert.match(setCookie, /HttpOnly/i, 'HttpOnly であること');
    assert.match(setCookie, /SameSite=Lax/i, 'SameSite=Lax であること');
    assert.ok(!/Secure/i.test(setCookie), 'cookieSecure 未指定(開発)では Secure なし');

    const cookie = setCookie.split(';', 1)[0] as string;
    const home = await getPage(base, '/', cookie);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /今日のトレンド/);
  } finally {
    await close();
  }
});

test('auth: でたらめな Cookie ではアクセスできない', async () => {
  const { base, close } = await startApp();
  try {
    await setupAdmin(base);
    const res = await getPage(base, '/', 'session=forged-token-value');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
  } finally {
    await close();
  }
});

test('auth: ログアウトでセッションが失効する', async () => {
  const { base, cookie, close } = await startLoggedIn();
  try {
    const out = await postForm(base, '/logout', {}, { cookie });
    assert.equal(out.status, 303);
    const after = await getPage(base, '/', cookie);
    assert.equal(after.status, 302, 'ログアウト後は同じ Cookie で入れない');
  } finally {
    await close();
  }
});

test('auth: セッションは期限切れで失効する(30日)', async () => {
  const { base, cookie, clock, close } = await startLoggedIn();
  try {
    assert.equal((await getPage(base, '/', cookie)).status, 200);
    clock.current = new Date(clock.current.getTime() + 31 * 24 * 60 * 60_000);
    const expired = await getPage(base, '/', cookie);
    assert.equal(expired.status, 302, '期限切れセッションは /login へ');
  } finally {
    await close();
  }
});

test('csrf: Origin が無い/異なるフォーム POST は拒否される', async () => {
  const { base, repos, cookie, close } = await startLoggedIn();
  try {
    const noOrigin = await fetch(`${base}/feeds`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ name: 'X', feed_url: 'https://x.example.com/rss', fetch_interval_minutes: '60' }).toString(),
    });
    assert.equal(noOrigin.status, 403, 'Origin なしは 403');
    const evil = await postForm(
      base,
      '/feeds',
      { name: 'X', feed_url: 'https://x.example.com/rss', fetch_interval_minutes: '60' },
      { cookie, origin: 'https://evil.example.com' },
    );
    assert.equal(evil.status, 403, '異なる Origin は 403');
    assert.equal((await repos.feeds.list()).length, 0, 'フィードは作成されていない');
  } finally {
    await close();
  }
});

test('auth: セッション Cookie では MCP / collect は通らない(系統分離)', async () => {
  const { base, cookie, close } = await startLoggedIn();
  try {
    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(mcp.status, 401);
    const collect = await fetch(`${base}/internal/collect`, { method: 'POST', headers: { cookie } });
    assert.equal(collect.status, 401);
  } finally {
    await close();
  }
});

/* ----------------------------------------------------- feeds CRUD(T4-1) */

test('feeds: ブラウザフォームからフィードを追加できる', async () => {
  const { base, repos, cookie, close } = await startLoggedIn();
  try {
    const res = await postForm(
      base,
      '/feeds',
      {
        name: 'Hacker News',
        feed_url: 'https://news.ycombinator.com/rss',
        site_url: 'https://news.ycombinator.com',
        fetch_interval_minutes: '30',
        enabled: 'on',
        translate: 'on',
        tos_note: '個人利用',
      },
      { cookie },
    );
    assert.equal(res.status, 303);
    const feeds = await repos.feeds.list();
    assert.equal(feeds.length, 1);
    const feed = feeds[0]!;
    assert.equal(feed.name, 'Hacker News');
    assert.equal(feed.feedUrl, 'https://news.ycombinator.com/rss');
    assert.equal(feed.siteUrl, 'https://news.ycombinator.com');
    assert.equal(feed.fetchIntervalMinutes, 30);
    assert.equal(feed.enabled, true);
    assert.equal(feed.translate, true);
    assert.equal(feed.fulltextAllowed, false, 'チェックなしは false');
    assert.equal(feed.tosNote, '個人利用');

    const page = await getPage(base, '/feeds', cookie);
    assert.match(await page.text(), /Hacker News/);
  } finally {
    await close();
  }
});

test('feeds: 不正な入力は 400(危険スキーム・非URL・間隔<15・名前なし)', async () => {
  const { base, repos, cookie, close } = await startLoggedIn();
  try {
    const cases: Array<Record<string, string>> = [
      { name: 'X', feed_url: 'javascript:alert(1)', fetch_interval_minutes: '60' },
      { name: 'X', feed_url: 'ftp://example.com/feed', fetch_interval_minutes: '60' },
      { name: 'X', feed_url: 'not a url', fetch_interval_minutes: '60' },
      { name: 'X', feed_url: 'https://ok.example.com/rss', fetch_interval_minutes: '5' },
      { name: 'X', feed_url: 'https://ok.example.com/rss', fetch_interval_minutes: 'abc' },
      { name: '', feed_url: 'https://ok.example.com/rss', fetch_interval_minutes: '60' },
      { name: 'X', feed_url: 'https://ok.example.com/rss', site_url: 'javascript:alert(2)', fetch_interval_minutes: '60' },
    ];
    for (const body of cases) {
      const res = await postForm(base, '/feeds', body, { cookie });
      assert.equal(res.status, 400, `${JSON.stringify(body)} は 400`);
    }
    assert.equal((await repos.feeds.list()).length, 0);
  } finally {
    await close();
  }
});

test('feeds: プライベート/予約 IP リテラルの feed_url は 400、公開IP・ホスト名は許可(SSRF入口)', async () => {
  const { base, repos, cookie, close } = await startLoggedIn();
  try {
    // 拒否: プライベート/予約 IP リテラル(feed_url / site_url とも)
    const rejected: Array<Record<string, string>> = [
      { name: 'X', feed_url: 'http://127.0.0.1/rss', fetch_interval_minutes: '60' },
      { name: 'X', feed_url: 'http://169.254.169.254/latest/meta-data/', fetch_interval_minutes: '60' },
      { name: 'X', feed_url: 'http://10.0.0.5/rss', fetch_interval_minutes: '60' },
      { name: 'X', feed_url: 'http://[::1]/rss', fetch_interval_minutes: '60' },
      { name: 'X', feed_url: 'https://ok.example.com/rss', site_url: 'http://192.168.1.1/', fetch_interval_minutes: '60' },
    ];
    for (const body of rejected) {
      const res = await postForm(base, '/feeds', body, { cookie });
      assert.equal(res.status, 400, `${JSON.stringify(body)} は 400`);
    }
    assert.equal((await repos.feeds.list()).length, 0, 'プライベート宛ては1件も作成されない');

    // 許可: 公開 IP リテラルとホスト名(登録は通す。解決先チェックは取得時/プロキシ)
    const okLiteral = await postForm(
      base,
      '/feeds',
      { name: 'PublicIP', feed_url: 'http://93.184.216.34/rss', fetch_interval_minutes: '60' },
      { cookie },
    );
    assert.equal(okLiteral.status, 303, '公開 IP リテラルは許可');
    assert.equal((await repos.feeds.list()).length, 1);
  } finally {
    await close();
  }
});

test('feeds: feed_url の重複は 409 でエラーメッセージを表示', async () => {
  const { base, cookie, close } = await startLoggedIn();
  try {
    const body = { name: 'A', feed_url: 'https://dup.example.com/rss', fetch_interval_minutes: '60' };
    assert.equal((await postForm(base, '/feeds', body, { cookie })).status, 303);
    const dup = await postForm(base, '/feeds', { ...body, name: 'B' }, { cookie });
    assert.equal(dup.status, 409);
    assert.match(await dup.text(), /すでに登録されています/);
  } finally {
    await close();
  }
});

test('feeds: 編集フォームで更新できる(fulltext_allowed / tos_note 含む)', async () => {
  const { base, repos, cookie, close } = await startLoggedIn();
  try {
    const feed = await repos.feeds.create({ name: 'Old', feedUrl: 'https://old.example.com/rss' });
    const editPage = await getPage(base, `/feeds/${feed.id}`, cookie);
    assert.equal(editPage.status, 200);
    assert.match(await editPage.text(), /https:\/\/old\.example\.com\/rss/);

    const res = await postForm(
      base,
      `/feeds/${feed.id}`,
      {
        name: 'New Name',
        feed_url: 'https://new.example.com/rss',
        fetch_interval_minutes: '120',
        enabled: 'on',
        fulltext_allowed: 'on',
        tos_note: '規約確認済み 2026-07-16',
      },
      { cookie },
    );
    assert.equal(res.status, 303);
    const updated = await repos.feeds.getById(feed.id);
    assert.equal(updated?.name, 'New Name');
    assert.equal(updated?.feedUrl, 'https://new.example.com/rss');
    assert.equal(updated?.fetchIntervalMinutes, 120);
    assert.equal(updated?.fulltextAllowed, true);
    assert.equal(updated?.translate, false, 'チェックを外した translate は false になる');
    assert.equal(updated?.tosNote, '規約確認済み 2026-07-16');
  } finally {
    await close();
  }
});

test('feeds: 有効/無効の切り替えと削除(記事も消える)', async () => {
  const { base, repos, cookie, close } = await startLoggedIn();
  try {
    await seed(repos);
    const feed = (await repos.feeds.list())[0]!;

    const toggled = await postForm(base, `/feeds/${feed.id}/toggle`, {}, { cookie });
    assert.equal(toggled.status, 303);
    assert.equal((await repos.feeds.getById(feed.id))?.enabled, false);
    await postForm(base, `/feeds/${feed.id}/toggle`, {}, { cookie });
    assert.equal((await repos.feeds.getById(feed.id))?.enabled, true);

    const deleted = await postForm(base, `/feeds/${feed.id}/delete`, {}, { cookie });
    assert.equal(deleted.status, 303);
    assert.equal(await repos.feeds.getById(feed.id), null);
    assert.equal((await repos.articles.listRecent()).length, 0, 'cascade で記事も消える');
  } finally {
    await close();
  }
});

test('feeds: 不正な UUID・不存在 ID は 404', async () => {
  const { base, cookie, close } = await startLoggedIn();
  try {
    assert.equal((await getPage(base, '/feeds/not-a-uuid', cookie)).status, 404);
    assert.equal(
      (await getPage(base, '/feeds/00000000-0000-0000-0000-000000000000', cookie)).status,
      404,
    );
    assert.equal(
      (await postForm(base, '/feeds/00000000-0000-0000-0000-000000000000/delete', {}, { cookie })).status,
      404,
    );
  } finally {
    await close();
  }
});

/* ------------------------------------------------------------ ページ表示 */

test('pages: 記事一覧が表示され、タイトル・フィード名は HTML エスケープされる(XSS対策)', async () => {
  const { repos, base, cookie, close } = await startLoggedIn();
  try {
    await seed(repos);
    const res = await getPage(base, '/articles', cookie);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /PostgreSQL 17 Released/);
    assert.match(html, /https:\/\/one\.example\.com\/pg17/);
    assert.ok(!html.includes('<script>alert(1)</script>'), '生の script タグが出力されてはならない');
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    const feedsHtml = await (await getPage(base, '/feeds', cookie)).text();
    assert.match(feedsHtml, /Feed &lt;One&gt;/);
  } finally {
    await close();
  }
});

test('pages: q / date / feed フィルタと不正値の拒否', async () => {
  const { repos, base, cookie, close } = await startLoggedIn();
  try {
    await seed(repos);
    const q = await (await getPage(base, '/articles?q=postgresql', cookie)).text();
    assert.match(q, /PostgreSQL 17 Released/);
    assert.ok(!q.includes('injection attempt'));

    const day = await (await getPage(base, '/articles?date=2026-07-14', cookie)).text();
    assert.match(day, /injection attempt/);
    assert.ok(!day.includes('PostgreSQL 17 Released'));

    assert.equal((await getPage(base, '/articles?date=not-a-date', cookie)).status, 400);
    assert.equal((await getPage(base, '/articles?date=2026-02-31', cookie)).status, 400);
    assert.equal((await getPage(base, '/articles?date=2026-99-99', cookie)).status, 400);
    assert.equal((await getPage(base, '/articles?date=2026-02-28', cookie)).status, 200);
    assert.equal((await getPage(base, '/articles?feed=not-a-uuid', cookie)).status, 400);
  } finally {
    await close();
  }
});

test('pages: q+feed 併用は指定フィードの記事のみ表示(回帰)', async () => {
  const { repos, base, cookie, close } = await startLoggedIn();
  try {
    const feed1 = await repos.feeds.create({ name: 'Feed1', feedUrl: 'https://f1.example.com/rss' });
    const feed2 = await repos.feeds.create({ name: 'Feed2', feedUrl: 'https://f2.example.com/rss' });
    await repos.articles.upsertMany([
      {
        feedId: feed1.id,
        guid: 'a',
        title: 'Kubernetes on feed1',
        url: 'https://f1.example.com/a',
        publishedAt: new Date('2026-07-15T10:00:00Z'),
      },
      {
        feedId: feed2.id,
        guid: 'b',
        title: 'Kubernetes on feed2',
        url: 'https://f2.example.com/b',
        publishedAt: new Date('2026-07-15T09:00:00Z'),
      },
    ]);
    const html = await (await getPage(base, `/articles?q=kubernetes&feed=${feed1.id}`, cookie)).text();
    assert.match(html, /Kubernetes on feed1/);
    assert.ok(!html.includes('Kubernetes on feed2'), 'feed1 指定時に feed2 の記事が出てはならない');
  } finally {
    await close();
  }
});

test('pages: 危険な URL スキームはリンク化せずテキスト表示(javascript:/data:/パース不能)', async () => {
  const { repos, base, cookie, close } = await startLoggedIn();
  try {
    const feed = await repos.feeds.create({ name: 'Evil', feedUrl: 'https://evil.example.com/rss' });
    await repos.articles.upsertMany([
      { feedId: feed.id, guid: 'js', title: 'EvilJavascriptArticle', url: 'javascript:alert(1)', publishedAt: new Date('2026-07-15T10:00:00Z') },
      { feedId: feed.id, guid: 'data', title: 'EvilDataArticle', url: 'data:text/html,<script>alert(2)</script>', publishedAt: new Date('2026-07-15T09:00:00Z') },
      { feedId: feed.id, guid: 'bad', title: 'EvilUnparseableArticle', url: 'not a valid url', publishedAt: new Date('2026-07-15T08:00:00Z') },
      { feedId: feed.id, guid: 'ok', title: 'GoodHttpsArticle', url: 'https://evil.example.com/ok', publishedAt: new Date('2026-07-15T07:00:00Z') },
    ]);
    const html = await (await getPage(base, '/articles', cookie)).text();
    assert.ok(!html.includes('href="javascript:'), 'javascript: が href に現れてはならない');
    assert.ok(!html.includes('javascript:alert(1)'), 'javascript: URL 文字列が出力されてはならない');
    assert.ok(!html.includes('href="data:'), 'data: が href に現れてはならない');
    assert.ok(!/href="not a valid url"/.test(html), 'パース不能 URL が href に現れてはならない');
    assert.match(html, /EvilJavascriptArticle/);
    assert.match(html, /EvilDataArticle/);
    assert.match(html, /EvilUnparseableArticle/);
    assert.match(html, /href="https:\/\/evil\.example\.com\/ok"/);
  } finally {
    await close();
  }
});

test('pages: 属性を破るタイトル・クエリ再表示の防御(XSS拡充)', async () => {
  const { repos, base, cookie, close } = await startLoggedIn();
  try {
    const feed = await repos.feeds.create({ name: 'AttrFeed', feedUrl: 'https://attr.example.com/rss' });
    await repos.articles.upsertMany([
      {
        feedId: feed.id,
        guid: 'attr',
        title: `break"'><&marker`,
        url: 'https://attr.example.com/x',
        publishedAt: new Date('2026-07-15T10:00:00Z'),
      },
    ]);
    const html = await (await getPage(base, '/articles', cookie)).text();
    assert.ok(!html.includes(`break"'><&marker`), '生の危険文字列が出力されてはならない');
    assert.match(html, /break&quot;&#39;&gt;&lt;&amp;marker/);
    const qHtml = await (
      await getPage(base, `/articles?q=${encodeURIComponent('"><script>')}`, cookie)
    ).text();
    assert.ok(!qHtml.includes('"><script>'), 'クエリの生 script が value を破ってはならない');
    assert.match(qHtml, /value="&quot;&gt;&lt;script&gt;"/);
  } finally {
    await close();
  }
});

test('pages: ダッシュボードにトレンド枠・今朝更新・フィード状態・ログアウトが表示される', async () => {
  const { repos, base, cookie, close } = await startLoggedIn();
  try {
    await seed(repos);
    const html = await (await getPage(base, '/', cookie)).text();
    assert.match(html, /今日のトレンド/);
    assert.match(html, /今朝更新された記事/);
    assert.match(html, /フィードの状態/);
    assert.match(html, /href="\/articles"/, '記事一覧ページへの導線があること');
    assert.match(html, /action="\/logout"/, 'ログアウトボタンがあること');
    assert.match(html, new RegExp(ADMIN_USER), 'ログイン中ユーザー名が表示されること');
  } finally {
    await close();
  }
});

test('pages: 表示時刻は日本時間(JST)・?date= は JST の1日として解釈', async () => {
  const { repos, base, cookie, close } = await startLoggedIn();
  try {
    const feed = await repos.feeds.create({ name: 'JST', feedUrl: 'https://jst.example.com/rss' });
    await repos.articles.upsertMany([
      // 2026-07-14T20:30:00Z = 2026-07-15 05:30 JST
      { feedId: feed.id, guid: 'b1', title: 'LateNightUtcArticle', url: 'https://jst.example.com/b1', publishedAt: new Date('2026-07-14T20:30:00Z') },
      // 2026-07-15T16:00:00Z = 2026-07-16 01:00 JST
      { feedId: feed.id, guid: 'b2', title: 'NextJstDayArticle', url: 'https://jst.example.com/b2', publishedAt: new Date('2026-07-15T16:00:00Z') },
    ]);
    const list = await (await getPage(base, '/articles', cookie)).text();
    assert.match(list, /2026-07-15 05:30/, '公開日時は JST で表示される');
    assert.ok(!list.includes('2026-07-14 20:30'), 'UTC のままの時刻を表示しない');

    const day15 = await (await getPage(base, '/articles?date=2026-07-15', cookie)).text();
    assert.match(day15, /LateNightUtcArticle/, 'UTC 前日夜の記事は JST 当日に含まれる');
    assert.ok(!day15.includes('NextJstDayArticle'), 'JST 翌日の記事は含まれない');
    const day16 = await (await getPage(base, '/articles?date=2026-07-16', cookie)).text();
    assert.match(day16, /NextJstDayArticle/);
  } finally {
    await close();
  }
});

/* ------------------------------------------------- 互換リダイレクト等 */

test('compat: 旧 /ui パスは新パスへ 301(クエリ保持)', async () => {
  const { base, close } = await startApp();
  try {
    const ui = await getPage(base, '/ui');
    assert.equal(ui.status, 301);
    assert.equal(ui.headers.get('location'), '/');
    const articles = await getPage(base, '/ui/articles?q=abc');
    assert.equal(articles.status, 301);
    assert.equal(articles.headers.get('location'), '/articles?q=abc');
    const feeds = await getPage(base, '/ui/feeds');
    assert.equal(feeds.status, 301);
    assert.equal(feeds.headers.get('location'), '/feeds');
  } finally {
    await close();
  }
});

test('compat: / への検索クエリは /articles へ引き継がれる', async () => {
  const { base, cookie, close } = await startLoggedIn();
  try {
    const res = await getPage(base, '/?q=postgres', cookie);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/articles?q=postgres');
  } finally {
    await close();
  }
});

test('assets: htmx は認証なしで配信され、ページから参照されている', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/assets/htmx.min.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /javascript/);
    const js = await res.text();
    assert.ok(js.length > 10_000, 'htmx 本体が返ること');
  } finally {
    await close();
  }
});

test('login: 失敗時はアラート用属性つきで、どちらが誤りか判別できない文言を返す', async () => {
  const { base, close } = await startApp();
  try {
    await setupAdmin(base);
    const res = await postForm(base, '/login', { username: ADMIN_USER, password: 'wrong-password' });
    assert.equal(res.status, 401);
    const html = await res.text();
    // /assets/login.js が読む data-login-alert 属性がある
    assert.match(html, /data-login-alert="([^"]+)"/);
    const message = /data-login-alert="([^"]+)"/.exec(html)?.[1] ?? '';
    // ユーザー名・パスワードのどちらが誤りかを判別できない文言であること
    assert.match(message, /ユーザー名またはパスワード/);
    assert.ok(!message.includes('ユーザー名が'), 'ユーザー名単独の誤りを示唆しない');
    assert.ok(!message.includes('パスワードが違'), 'パスワード単独の誤りを示唆しない');
    // 未知ユーザーでも完全に同一のレスポンス文言(列挙不可)
    const unknown = await (
      await postForm(base, '/login', { username: 'nobody', password: 'wrong-password' })
    ).text();
    const unknownMessage = /data-login-alert="([^"]+)"/.exec(unknown)?.[1] ?? '';
    assert.equal(unknownMessage, message);
  } finally {
    await close();
  }
});

test('login: 背景・アラートJSはログイン画面のみ(setup・認証後ページには出ない)', async () => {
  const { base, close } = await startApp();
  try {
    // 背景SVGを適用する CSS ルールは .auth-shell.login クラスにのみ効くため、
    // 「ログイン画面だけ」の検証はクラスと script タグの有無で行う。
    // setup ページには付かない
    const setupHtml = await (await getPage(base, '/setup')).text();
    assert.ok(!setupHtml.includes('src="/assets/login.js"'), 'setup にアラートJSは不要');
    assert.ok(!setupHtml.includes('class="auth-shell login"'), 'setup に背景クラスは付かない');

    await setupAdmin(base);

    // ログイン画面には背景クラスとアラートJSが付く
    const loginHtml = await (await getPage(base, '/login')).text();
    assert.match(loginHtml, /class="auth-shell login"/);
    assert.match(loginHtml, /src="\/assets\/login\.js"/);
    // 背景SVGは外部CSS(/assets/app.css)から参照される。
    const css = await (await fetch(`${base}/assets/app.css`)).text();
    assert.match(css, /\/assets\/login-bg\.svg/, 'CSSから背景SVGを参照');

    // 認証後ページには付かない
    const cookie = await login(base);
    const dashHtml = await (await getPage(base, '/', cookie)).text();
    assert.ok(!dashHtml.includes('src="/assets/login.js"'), 'ダッシュボードにアラートJSは載らない');
    assert.ok(!dashHtml.includes('class="auth-shell login"'), 'ダッシュボードに背景クラスは付かない');
  } finally {
    await close();
  }
});

test('assets: app.css が配信され、ページはインラインCSSを持たない', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/assets/app.css`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/css/);
    assert.match(await res.text(), /--paper:/, 'テーマ変数を含む実体が返ること');

    await setupAdmin(base);
    const loginRes = await getPage(base, '/login');
    const loginHtml = await loginRes.text();
    assert.match(loginHtml, /<link rel="stylesheet" href="\/assets\/app\.css">/);
    // CSS ベタ書き禁止: <style> もインライン style 属性も出さない
    // (CSP style-src 'self' の前提。スタイルは app.css のクラスに追加する)。
    assert.ok(!loginHtml.includes('<style'), '<style> 禁止');
    assert.ok(!loginHtml.includes('style="'), 'style 属性禁止');
    const csp = loginRes.headers.get('content-security-policy') ?? '';
    assert.match(csp, /style-src 'self'(;|$)/, "style-src は 'self' のみ");
    assert.ok(!csp.includes("'unsafe-inline'"), 'unsafe-inline は廃止済み');

    const cookie = await login(base);
    const dashHtml = await (await getPage(base, '/', cookie)).text();
    assert.ok(!dashHtml.includes('<style') && !dashHtml.includes('style="'));
  } finally {
    await close();
  }
});

test('assets: login.js / login-bg.svg が配信され、SVGに危険要素がない', async () => {
  const { base, close } = await startApp();
  try {
    const js = await fetch(`${base}/assets/login.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
    assert.match(await js.text(), /data-login-alert/);

    const svg = await fetch(`${base}/assets/login-bg.svg`);
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get('content-type') ?? '', /image\/svg\+xml/);
    const body = await svg.text();
    assert.match(body, /<svg[^>]*viewBox="0 0 1600 1000"/);
    // SVG 経由のスクリプト実行・外部参照がないこと(サプライチェーン/XSS対策)
    assert.ok(!/<script/i.test(body), 'script 要素禁止');
    assert.ok(!/<foreignObject/i.test(body), 'foreignObject 禁止');
    assert.ok(!/href="https?:/i.test(body), '外部URL参照禁止');
    assert.ok(!/<image/i.test(body), 'image 要素禁止');
    assert.ok(!/on[a-z]+=/i.test(body), 'イベントハンドラ属性禁止');
  } finally {
    await close();
  }
});

test('security: 64KB を超えるフォームボディは 413 で拒否される(認証前DoS対策)', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
      body: `username=a&password=${'x'.repeat(70 * 1024)}`,
    });
    assert.equal(res.status, 413);
  } finally {
    await close();
  }
});

test('security: HTML ページに CSP / nosniff ヘッダが付く', async () => {
  const { base, close } = await startApp();
  try {
    await setupAdmin(base);
    const res = await getPage(base, '/login');
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  } finally {
    await close();
  }
});
