import type { Article, Feed } from '../domain/types.ts';
import type { RateView } from '../rates/service.ts';
import type { BuildInfo } from './build-info.ts';
import { assetPath } from './assets.ts';

/**
 * Wire Desk のビュー層(HTML 文字列レンダリング)。
 * ルーティング・認証は src/server/web.ts(Hono)が担い、ここは純粋な描画のみ。
 * 例外としてアセットURL(assetPath)だけは参照する — 静的な内容ハッシュ解決で、
 * 初回以降はキャッシュ済みのため描画の純粋性・性能に影響しない。
 */

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * http:/https: のみを安全なリンク先として許可する。
 * フィード由来の javascript:/data: やパース不能 URL は null を返し、
 * 呼び出し側でリンク化せずテキスト表示させる(クリック時のスクリプト実行を防ぐ)。
 */
export function safeHttpUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? raw : null;
}

/**
 * YYYY-MM-DD が実在日かを UTC ラウンドトリップで検証する。
 * 形式は通るが存在しない日(2026-02-31 / 2026-99-99 等)を DB 到達前に弾く。
 */
export function isRealDate(date: string): boolean {
  const m = DATE_RE.exec(date);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day
  );
}

export const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ------------------------------------------------------------ JST 表示 */
// DB 上のデータは UTC のまま。表示のみ日本時間(UTC+9、DST なし)へ変換する。

const JST_OFFSET_MS = 9 * 60 * 60_000;
const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** UTC の Date を「JST の壁時計を UTC フィールドに持つ Date」へシフトする。 */
function toJstClock(d: Date): Date {
  return new Date(d.getTime() + JST_OFFSET_MS);
}

export function jstDayStamp(d: Date): string {
  return toJstClock(d).toISOString().slice(0, 10);
}

function jaDateJst(d: Date): string {
  const j = toJstClock(d);
  return `${j.getUTCFullYear()}年${j.getUTCMonth() + 1}月${j.getUTCDate()}日(${WEEKDAYS_JA[j.getUTCDay()]})`;
}

function hhmmJst(d: Date): string {
  return toJstClock(d).toISOString().slice(11, 16);
}

/** '2026-07-15 05:30' 形式(JST)。 */
function fmtDateTimeJst(date: Date | null): string {
  if (date === null) return '—';
  const j = toJstClock(date).toISOString();
  return `${j.slice(0, 10)} ${j.slice(11, 16)}`;
}

/** '07-15 05:30' 形式(JST、ワイヤー用)。 */
function fmtWireJst(date: Date | null): string {
  if (date === null) return '--:--';
  const j = toJstClock(date).toISOString();
  return `${j.slice(5, 10)} ${j.slice(11, 16)}`;
}

/* ------------------------------------------------------------- rendering */

export type NavKey = 'dashboard' | 'articles' | 'feeds';

export interface PageContext {
  now: Date;
  activeNav: NavKey;
  /** ログイン中のユーザー名(ツールバー表示・ログアウトボタン用)。 */
  username: string;
  query?: { q: string; date: string };
  /** バージョン・ビルド情報。指定時のみフッターに表示する(認証済みページ限定)。 */
  buildInfo?: BuildInfo;
}

function htmlDocument(title: string, body: string, extraScripts = ''): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${assetPath('app.css')}">
<script src="${assetPath('htmx.min.js')}" defer></script>${extraScripts}
</head>
<body hx-boost="true">
${body}
</body>
</html>`;
}

/**
 * フッター用のバージョン表記(例: `v0.1.0 · ba5190f6a2c1`)。
 * commit は視認性のため 12 桁に短縮し、builtAt は title 属性で補足する。
 */
function buildInfoSpan(info: BuildInfo | undefined): string {
  if (info === undefined) return '';
  const commitShort = info.commit === 'unknown' ? 'unknown' : info.commit.slice(0, 12);
  const title = info.builtAt !== undefined ? ` title="built at ${escapeHtml(info.builtAt)}"` : '';
  return `\n  <span class="build-info"${title}>v${escapeHtml(info.version)} · <code>${escapeHtml(commitShort)}</code></span>`;
}

export function layout(title: string, ctx: PageContext, body: string): string {
  const q = ctx.query?.q ?? '';
  const date = ctx.query?.date ?? '';
  const current = (key: NavKey) => (ctx.activeNav === key ? ' aria-current="page"' : '');
  return htmlDocument(
    title,
    `<div class="shell">
<header class="masthead">
  <div class="masthead-row">
    <h1 class="brand">Wire<span class="tick"> /</span> Desk</h1>
    <span class="masthead-date" data-clock="date">${jaDateJst(ctx.now)}</span>
    <span class="masthead-meta">PERSONAL RSS READER · <span data-clock="time" data-epoch="${ctx.now.getTime()}">${hhmmJst(ctx.now)}</span> JST</span>
  </div>
  <div class="toolbar">
    <nav class="nav" aria-label="ページ">
      <a href="/"${current('dashboard')}>ダッシュボード</a>
      <a href="/articles"${current('articles')}>記事一覧</a>
      <a href="/feeds"${current('feeds')}>フィード</a>
    </nav>
    <form class="search" method="get" action="/articles">
      <input type="text" name="q" placeholder="タイトルを検索" value="${escapeHtml(q)}" aria-label="タイトル検索">
      <input type="date" name="date" value="${escapeHtml(date)}" aria-label="日付で絞り込み(JST)">
      <button type="submit">表示</button>
    </form>
    <div class="session-box">
      <span>${escapeHtml(ctx.username)}</span>
      <form method="post" action="/logout"><button type="submit" class="btn-ghost">ログアウト</button></form>
    </div>
  </div>
</header>
${body}
<footer class="colophon">
  <span>時刻はすべて日本時間(JST)</span>${buildInfoSpan(ctx.buildInfo)}
</footer>
</div>`,
    `\n<script src="${assetPath('clock.js')}" defer></script>`,
  );
}

/**
 * ログイン・セットアップ用のセンタリングレイアウト(ナビなし)。
 * `login: true` はログイン画面専用の装飾(幾何学模様背景・失敗アラート用JS)を有効化する。
 */
export function authLayout(title: string, body: string, opts: { login?: boolean } = {}): string {
  return htmlDocument(
    title,
    `<div class="auth-shell${opts.login ? ' login' : ''}">
<div class="auth-card">
  <h1 class="brand">Wire<span class="tick"> /</span> Desk</h1>
  <p class="auth-sub">PERSONAL RSS READER</p>
  ${body}
</div>
</div>`,
    opts.login ? `\n<script src="${assetPath('login.js')}" defer></script>` : '',
  );
}

function articleTitleHtml(article: Article): string {
  const href = safeHttpUrl(article.url);
  return href === null
    ? escapeHtml(article.title)
    : `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${escapeHtml(article.title)}</a>`;
}

function wireItem(article: Article, feedsById: Map<string, Feed>): string {
  const feed = feedsById.get(article.feedId);
  return `<li>
<span class="t">${fmtWireJst(article.publishedAt)}</span>
<span class="headline">${articleTitleHtml(article)}<span class="src">${escapeHtml(feed?.name ?? article.feedId)}</span></span>
</li>`;
}

function rowItem(article: Article, feedsById: Map<string, Feed>): string {
  const feed = feedsById.get(article.feedId);
  return `<li>
<span class="headline">${articleTitleHtml(article)}<span class="src">${escapeHtml(feed?.name ?? article.feedId)}</span></span>
<span class="when">${fmtDateTimeJst(article.publishedAt)}</span>
</li>`;
}

/** 'USDJPY' → 'USD/JPY'。pair は設定時に [A-Z]{6} 検証済みだが表示は常にエスケープする。 */
function fmtPair(pair: string): string {
  return `${pair.slice(0, 3)}/${pair.slice(3)}`;
}

/** 為替レートの表示桁。円クロス等の大きい値は2桁、ドルストレート等は4桁。 */
function fmtRate(rate: number): string {
  return rate >= 20 ? rate.toFixed(2) : rate.toFixed(4);
}

/** 為替レートの stat カード(設計書 §14)。stale = TTL 切れの古い値を表示中。 */
function fxStat(view: RateView): string {
  let move = '';
  if (view.prevClose !== null && view.prevClose > 0) {
    const pct = ((view.rate - view.prevClose) / view.prevClose) * 100;
    const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : '';
    const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '±';
    move = `<span class="move${cls === '' ? '' : ` ${cls}`}">${arrow}${Math.abs(pct).toFixed(2)}%</span> · `;
  }
  const asOf = view.marketTime ?? view.fetchedAt;
  const staleNote = view.stale ? ' · <span class="stale-note">更新停止中</span>' : '';
  return `<div class="stat fx${view.stale ? ' stale' : ''}">
    <div class="num">${escapeHtml(fmtRate(view.rate))}</div>
    <div class="label">${escapeHtml(fmtPair(view.pair))}</div>
    <div class="sub">${move}${hhmmJst(asOf)} JST${staleNote}</div>
  </div>`;
}

function statsStrip(input: {
  last24Count: number;
  feeds: Feed[];
  lastFetched: Date | null;
  rates: RateView[];
}): string {
  const enabled = input.feeds.filter((f) => f.enabled).length;
  const fulltext = input.feeds.filter((f) => f.fulltextAllowed).length;
  const fx = input.rates.map((r) => `\n  ${fxStat(r)}`).join('');
  return `<section class="stats" aria-label="概況">
  <div class="stat">
    <div class="num">${input.last24Count}<span class="unit">件</span></div>
    <div class="label">直近24時間</div>
    <div class="sub">published / 24h</div>
  </div>
  <div class="stat">
    <div class="num">${enabled}<span class="unit">/ ${input.feeds.length}</span></div>
    <div class="label">有効フィード</div>
    <div class="sub">enabled / total</div>
  </div>
  <div class="stat">
    <div class="num">${fulltext}<span class="unit">件</span></div>
    <div class="label">本文取得可</div>
    <div class="sub">fulltext_allowed</div>
  </div>
  <div class="stat">
    <div class="num">${input.lastFetched === null ? '—' : hhmmJst(input.lastFetched)}</div>
    <div class="label">最終取得</div>
    <div class="sub">${input.lastFetched === null ? 'まだ収集していません' : `${jstDayStamp(input.lastFetched)} JST`}</div>
  </div>${fx}
</section>`;
}

function feedRail(feeds: Feed[]): string {
  const items = feeds
    .map(
      (f) => `<li>
<span class="dot${f.enabled ? '' : ' off'}" aria-hidden="true"></span>
<span class="fname">${escapeHtml(f.name)}</span>
<span class="fwhen">${f.lastFetchedAt === null ? '未取得' : hhmmJst(f.lastFetchedAt)}</span>
</li>`,
    )
    .join('\n');
  return `<section class="panel">
<h2>フィードの状態</h2>
<p class="panel-note">情報源と最終取得時刻(JST)</p>
<ul class="feedlist">
${items || '<li>フィードが未登録です</li>'}
</ul>
<p class="panel-more"><a href="/feeds">フィードを管理する →</a></p>
</section>`;
}

/** トレンド主役枠。MCP 側の分析データ(未決事項 U6)が来たらここへ流し込む。 */
const TREND_PANEL = `<section class="panel">
<h2>今日のトレンド</h2>
<p class="panel-note">収集した見出しから抽出したトピック</p>
<div class="trend-empty">
  <span class="mark" aria-hidden="true">◈</span>
  <div>
    <p>トレンドはまだ分析されていません。</p>
    <p class="sub">MCP クライアント(Claude / ChatGPT)から get_daily_titles を呼ぶと、この枠にトピック抽出と日本語ダイジェストを表示する予定です(未決事項 U6)。</p>
  </div>
</div>
</section>`;

const DIGEST_SLOT = `<section class="panel slot">
<h2>デイリーダイジェスト</h2>
<p>AI が生成した日次まとめの保存先(未決事項 U6 の確定後に実装)。</p>
</section>`;

const WIRE_MAX = 12;

export function dashboardBody(input: {
  last24: Article[];
  feeds: Feed[];
  rates?: RateView[];
}): string {
  const feedsById = new Map(input.feeds.map((f) => [f.id, f]));
  const lastFetched = input.feeds.reduce<Date | null>(
    (acc, f) =>
      f.lastFetchedAt !== null && (acc === null || f.lastFetchedAt > acc) ? f.lastFetchedAt : acc,
    null,
  );
  const wireItems = input.last24.slice(0, WIRE_MAX);
  const wire =
    wireItems.length === 0
      ? '<p class="empty">直近24時間の記事はまだありません。</p>'
      : `<ol class="wire">\n${wireItems.map((a) => wireItem(a, feedsById)).join('\n')}\n</ol>`;
  return `${statsStrip({ last24Count: input.last24.length, feeds: input.feeds, lastFetched, rates: input.rates ?? [] })}
<main class="grid">
  <div class="col-main">
    ${TREND_PANEL}
    <section class="panel">
      <h2>今朝更新された記事</h2>
      <p class="panel-note">直近24時間に公開された記事 — 新着順(JST)${input.last24.length > WIRE_MAX ? ` · 上位${WIRE_MAX}件` : ''}</p>
      ${wire}
      <p class="panel-more"><a href="/articles">記事一覧を見る →</a></p>
    </section>
  </div>
  <aside class="rail">
    ${feedRail(input.feeds)}
    ${DIGEST_SLOT}
  </aside>
</main>`;
}

export function articlesBody(input: {
  articles: Article[];
  feeds: Feed[];
  q: string;
  date: string;
  feedId: string;
  category: string;
}): string {
  const feedsById = new Map(input.feeds.map((f) => [f.id, f]));
  const hasFilter =
    input.q !== '' || input.date !== '' || input.feedId !== '' || input.category !== '';
  const parts: string[] = [];
  if (input.q !== '') parts.push(`「${escapeHtml(input.q)}」を含むタイトル`);
  if (input.date !== '') parts.push(`${escapeHtml(input.date)}(JST)公開`);
  if (input.feedId !== '') {
    const feed = feedsById.get(input.feedId);
    parts.push(`フィード: ${escapeHtml(feed?.name ?? input.feedId)}`);
  }
  if (input.category !== '') parts.push(`カテゴリ: ${escapeHtml(input.category)}`);
  const note = hasFilter
    ? `${parts.join(' / ')} — ${input.articles.length}件`
    : `公開日時の新しい順(JST) — ${input.articles.length}件`;
  // カテゴリごとの導線(チップ)。フィードにカテゴリが1つでも付いていれば表示する。
  const categories = feedCategories(input.feeds);
  const chips =
    categories.length === 0
      ? ''
      : `<nav class="cat-chips" aria-label="カテゴリで絞り込み">
        <a class="btn-small" href="/articles"${input.category === '' ? ' aria-current="true"' : ''}>すべて</a>
        ${categories
          .map(
            (cat) =>
              `<a class="btn-small" href="/articles?category=${escapeHtml(encodeURIComponent(cat))}"${cat === input.category ? ' aria-current="true"' : ''}>${escapeHtml(cat)}</a>`,
          )
          .join('\n        ')}
      </nav>
      `;
  const rows =
    input.articles.length === 0
      ? `<p class="empty">${hasFilter ? '該当する記事はありません。条件を変えて検索してください。' : '記事がまだありません。フィードを登録して収集を実行してください。'}</p>`
      : `<ul class="rows">\n${input.articles.map((a) => rowItem(a, feedsById)).join('\n')}\n</ul>`;
  return `<main class="grid pad-top">
  <div class="col-main">
    <section class="panel">
      <h2>${hasFilter ? '検索結果' : '記事一覧'}</h2>
      ${chips}<p class="result-note">${note}</p>
      ${rows}
    </section>
  </div>
  <aside class="rail">
    ${feedRail(input.feeds)}
  </aside>
</main>`;
}

/* ----------------------------------------------------- feeds 管理(T4-1) */

/** フォーム再表示用の入力値(バリデーションエラー時に入力を失わせない)。 */
export interface FeedFormValues {
  name: string;
  feedUrl: string;
  siteUrl: string;
  fetchIntervalMinutes: string;
  translate: boolean;
  fulltextAllowed: boolean;
  enabled: boolean;
  tosNote: string;
  category: string;
}

export const EMPTY_FEED_FORM: FeedFormValues = {
  name: '',
  feedUrl: '',
  siteUrl: '',
  fetchIntervalMinutes: '60',
  translate: true,
  fulltextAllowed: false,
  enabled: true,
  tosNote: '',
  category: '',
};

export function feedToFormValues(feed: Feed): FeedFormValues {
  return {
    name: feed.name,
    feedUrl: feed.feedUrl,
    siteUrl: feed.siteUrl ?? '',
    fetchIntervalMinutes: String(feed.fetchIntervalMinutes),
    translate: feed.translate,
    fulltextAllowed: feed.fulltextAllowed,
    enabled: feed.enabled,
    tosNote: feed.tosNote ?? '',
    category: feed.category ?? '',
  };
}

/** フィード群から重複を除いたカテゴリ一覧(表示順は五十音等のロケール順)。 */
function feedCategories(feeds: Feed[]): string[] {
  const set = new Set<string>();
  for (const f of feeds) {
    if (f.category !== null && f.category !== '') set.add(f.category);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
}

function feedFormFields(values: FeedFormValues, categoryOptions: string[] = []): string {
  const checked = (b: boolean) => (b ? ' checked' : '');
  const datalist =
    categoryOptions.length > 0
      ? `\n<datalist id="category-options">\n${categoryOptions
          .map((cat) => `<option value="${escapeHtml(cat)}"></option>`)
          .join('\n')}\n</datalist>`
      : '';
  return `<div class="field">
  <label for="feed-name">名前</label>
  <input id="feed-name" type="text" name="name" required maxlength="200" value="${escapeHtml(values.name)}">
</div>
<div class="field">
  <label for="feed-url">フィードURL <span class="hint">(http/https)</span></label>
  <input id="feed-url" type="url" name="feed_url" required maxlength="2048" placeholder="https://example.com/rss" value="${escapeHtml(values.feedUrl)}">
</div>
<div class="field">
  <label for="site-url">サイトURL <span class="hint">(任意)</span></label>
  <input id="site-url" type="url" name="site_url" maxlength="2048" value="${escapeHtml(values.siteUrl)}">
</div>
<div class="field">
  <label for="interval">取得間隔(分) <span class="hint">最小15</span></label>
  <input id="interval" type="number" name="fetch_interval_minutes" required min="15" step="1" value="${escapeHtml(values.fetchIntervalMinutes)}">
</div>
<div class="field">
  <label for="feed-category">カテゴリ <span class="hint">(任意。同じ名前で配信元をまとめる)</span></label>
  <input id="feed-category" type="text" name="category" maxlength="100"${categoryOptions.length > 0 ? ' list="category-options"' : ''} value="${escapeHtml(values.category)}">${datalist}
</div>
<div class="check-row">
  <label><input type="checkbox" name="enabled"${checked(values.enabled)}> 有効(収集対象)</label>
  <label><input type="checkbox" name="translate"${checked(values.translate)}> 翻訳対象</label>
  <label><input type="checkbox" name="fulltext_allowed"${checked(values.fulltextAllowed)}> 本文取得を許可 <span class="hint">※規約確認に基づく手動設定のみ(設計書 §6)</span></label>
</div>
<div class="field wide">
  <label for="tos-note">規約メモ <span class="hint">(fulltext 許可の根拠などを記録)</span></label>
  <textarea id="tos-note" name="tos_note" maxlength="2000">${escapeHtml(values.tosNote)}</textarea>
</div>`;
}

export function feedsBody(input: {
  feeds: Feed[];
  error?: string;
  notice?: string;
  form?: FeedFormValues;
}): string {
  const form = input.form ?? EMPTY_FEED_FORM;
  const categories = feedCategories(input.feeds);
  const rows = input.feeds
    .map(
      (f) => `<tr>
<td>${escapeHtml(f.name)}<div class="furl">${escapeHtml(f.feedUrl)}</div></td>
<td>${
        f.category === null
          ? '—'
          : `<a href="/articles?category=${escapeHtml(encodeURIComponent(f.category))}">${escapeHtml(f.category)}</a>`
      }</td>
<td><span class="flag ${f.enabled ? 'on' : 'off'}">${f.enabled ? '● 有効' : '○ 無効'}</span></td>
<td><span class="flag ${f.fulltextAllowed ? 'on' : 'off'}">${f.fulltextAllowed ? '可' : '不可'}</span></td>
<td class="c">${f.fetchIntervalMinutes}分</td>
<td class="c">${fmtDateTimeJst(f.lastFetchedAt)}</td>
<td>
  <div class="row-actions">
    <form method="post" action="/feeds/${escapeHtml(f.id)}/toggle"><button type="submit" class="btn-small">${f.enabled ? '無効化' : '有効化'}</button></form>
    <a class="btn-small" href="/feeds/${escapeHtml(f.id)}">編集</a>
    <a class="btn-small" href="/articles?feed=${escapeHtml(f.id)}">記事</a>
    <form method="post" action="/feeds/${escapeHtml(f.id)}/delete" hx-confirm="「${escapeHtml(f.name)}」を削除します。記事も一緒に削除されます。よろしいですか?"><button type="submit" class="btn-small danger">削除</button></form>
  </div>
</td>
</tr>`,
    )
    .join('\n');
  return `<main class="mt-22">
${input.error ? `<div class="banner error" role="alert">${escapeHtml(input.error)}</div>` : ''}
${input.notice ? `<div class="banner notice">${escapeHtml(input.notice)}</div>` : ''}
<section class="panel mt-14">
<h2>フィードを追加</h2>
<p class="panel-note">RSS / Atom フィードの URL を登録すると次回の収集から対象になります</p>
<form method="post" action="/feeds" class="form-grid">
${feedFormFields(form, categories)}
<div class="form-actions"><button type="submit" class="btn">追加する</button></div>
</form>
</section>
<section class="panel mt-22">
<h2>フィード一覧</h2>
<p class="panel-note">収集対象の情報源と規約フラグ</p>
<div class="table-scroll">
<table class="ftable">
<thead><tr><th>名前 / URL</th><th>カテゴリ</th><th>状態</th><th>本文取得</th><th>間隔</th><th>最終取得 (JST)</th><th>操作</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="7" class="empty">フィードが未登録です</td></tr>'}
</tbody>
</table>
</div>
</section>
</main>`;
}

export function feedEditBody(input: {
  feed: Feed;
  error?: string;
  form?: FeedFormValues;
  /** datalist に出す既存カテゴリ一覧(任意)。 */
  categories?: string[];
}): string {
  const form = input.form ?? feedToFormValues(input.feed);
  return `<main class="mt-22">
${input.error ? `<div class="banner error" role="alert">${escapeHtml(input.error)}</div>` : ''}
<section class="panel mt-14">
<h2>フィードを編集</h2>
<p class="panel-note">${escapeHtml(input.feed.name)} — 最終取得: ${fmtDateTimeJst(input.feed.lastFetchedAt)}</p>
<form method="post" action="/feeds/${escapeHtml(input.feed.id)}" class="form-grid">
${feedFormFields(form, input.categories ?? [])}
<div class="form-actions">
  <button type="submit" class="btn">保存する</button>
  <a class="btn-small" href="/feeds">一覧へ戻る</a>
</div>
</form>
</section>
</main>`;
}

/* -------------------------------------------------------- auth pages */

export function loginBody(input: { error?: string; notice?: string; next?: string } = {}): string {
  // data-login-alert: /assets/login.js が読み取り window.alert を出す。
  // 文言はどのフィールドが誤りかを判別できないものだけを渡すこと(ユーザー列挙対策)。
  // next はサーバー側で検証済みの相対パスのみが渡される(オープンリダイレクト対策は web.ts)。
  return `${input.error ? `<div class="banner error" role="alert" data-login-alert="${escapeHtml(input.error)}">${escapeHtml(input.error)}</div>` : ''}
${input.notice ? `<div class="banner notice">${escapeHtml(input.notice)}</div>` : ''}
<form method="post" action="/login">
  ${input.next !== undefined ? `<input type="hidden" name="next" value="${escapeHtml(input.next)}">` : ''}
  <div class="field">
    <label for="username">ユーザー名</label>
    <input id="username" type="text" name="username" required autocomplete="username" autofocus>
  </div>
  <div class="field">
    <label for="password">パスワード</label>
    <input id="password" type="password" name="password" required autocomplete="current-password">
  </div>
  <button type="submit" class="btn">ログイン</button>
</form>`;
}

/** OAuth 同意画面(T4-2)。表示文字列はすべて escapeHtml 済みで渡すこと。 */
export function consentBody(input: {
  requestId: string;
  clientName: string;
  redirectUri: string;
  scopes: string[];
  username: string;
}): string {
  return `<p class="note note-lead">
MCP クライアントが <strong>${escapeHtml(input.username)}</strong> としてこのサーバーへの接続を要求しています。
</p>
<dl class="consent-facts">
  <dt>クライアント</dt>
  <dd>${escapeHtml(input.clientName)}</dd>
  <dt>許可後のリダイレクト先</dt>
  <dd class="wrap-any">${escapeHtml(input.redirectUri)}</dd>
  <dt>スコープ</dt>
  <dd>${escapeHtml(input.scopes.join(' '))}(記事・フィードの読み取りとダイジェスト保存)</dd>
</dl>
<form method="post" action="/oauth/consent">
  <input type="hidden" name="request" value="${escapeHtml(input.requestId)}">
  <div class="consent-actions">
    <button type="submit" name="action" value="approve" class="btn">許可する</button>
    <button type="submit" name="action" value="deny" class="btn-ghost small">拒否する</button>
  </div>
</form>`;
}

/** 同意リクエストが不明・期限切れのときのエラー表示。詳細は書きすぎない。 */
export function consentErrorBody(): string {
  return `<div class="banner error" role="alert">認可リクエストが無効か、有効期限が切れています。</div>
<p class="note">MCP クライアント側から接続をやり直してください。</p>`;
}

export function setupBody(
  input: { error?: string; username?: string; tokenRequired?: boolean } = {},
): string {
  const tokenField = input.tokenRequired
    ? `<div class="field">
    <label for="setup-token">セットアップトークン <span class="hint">(SETUP_TOKEN)</span></label>
    <input id="setup-token" type="password" name="setup_token" required autocomplete="off">
  </div>
`
    : '';
  return `${input.error ? `<div class="banner error" role="alert">${escapeHtml(input.error)}</div>` : ''}
<p class="note note-lead">初回セットアップ: 管理ユーザーを作成してください。</p>
<form method="post" action="/setup">
  ${tokenField}<div class="field">
    <label for="username">ユーザー名 <span class="hint">(英数と ._- のみ)</span></label>
    <input id="username" type="text" name="username" required maxlength="64" pattern="[A-Za-z0-9._\\-]+" autocomplete="username" value="${escapeHtml(input.username ?? '')}" autofocus>
  </div>
  <div class="field">
    <label for="password">パスワード <span class="hint">(8文字以上)</span></label>
    <input id="password" type="password" name="password" required minlength="8" autocomplete="new-password">
  </div>
  <div class="field">
    <label for="password-confirm">パスワード(確認)</label>
    <input id="password-confirm" type="password" name="password_confirm" required minlength="8" autocomplete="new-password">
  </div>
  <button type="submit" class="btn">作成してはじめる</button>
</form>`;
}

export function messagePage(ctx: PageContext, heading: string, message: string): string {
  return layout(
    heading,
    ctx,
    `<main><section class="panel mt-22"><h2>${escapeHtml(heading)}</h2><p class="result-note">${escapeHtml(message)}</p></section></main>`,
  );
}
