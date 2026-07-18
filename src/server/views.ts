import type { Article, Feed } from '../domain/types.ts';

/**
 * Wire Desk のビュー層(HTML 文字列レンダリング)。
 * ルーティング・認証は src/server/web.ts(Hono)が担い、ここは純粋な描画のみ。
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

/* ---------------------------------------------------------------- styles */

const STYLE = `
:root {
  --paper: #FAF9F6;
  --panel: #FFFFFF;
  --ink: #1C2637;
  --ink-2: #5B6579;
  --ink-3: #8B93A5;
  --line: #E5E2D9;
  --line-soft: #EFEDE6;
  --brass: #A8874C;
  --brass-ink: #8A6D39;
  --danger: #A0453C;
  --panel-shadow: 0 1px 2px rgba(28, 38, 55, 0.05);
  --serif: Georgia, "Times New Roman", "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif;
  --sans: system-ui, -apple-system, "Segoe UI", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Noto Sans JP", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #131A28;
    --panel: #1A2333;
    --ink: #E9E7E0;
    --ink-2: #A7AEBE;
    --ink-3: #6E7789;
    --line: #2B3549;
    --line-soft: #232D40;
    --brass: #C4A263;
    --brass-ink: #D3B87E;
    --danger: #D08A82;
    --panel-shadow: none;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.6;
}
a { color: inherit; text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--brass); }
a:focus-visible, button:focus-visible, input:focus-visible, textarea:focus-visible {
  outline: 2px solid var(--brass);
  outline-offset: 2px;
  border-radius: 2px;
}
.shell { max-width: 1160px; margin: 0 auto; padding: 0 20px 56px; }

/* masthead */
.masthead { padding: 26px 0 18px; border-bottom: 1px solid var(--ink); }
.masthead-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 18px; }
.brand { font-family: var(--serif); font-size: 1.7rem; font-weight: 600; letter-spacing: 0.01em; margin: 0; }
.brand .tick { color: var(--brass-ink); }
.masthead-date { font-family: var(--serif); font-size: 1.02rem; color: var(--ink-2); }
.masthead-meta { margin-left: auto; font-family: var(--mono); font-size: 0.74rem; color: var(--ink-3); letter-spacing: 0.02em; }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; padding: 10px 0 0; }
.nav { display: flex; gap: 14px; font-size: 0.86rem; }
.nav a { color: var(--ink-2); padding: 2px 0; }
.nav a[aria-current="page"] { color: var(--ink); border-bottom: 2px solid var(--brass); }
.search { display: flex; gap: 8px; margin-left: auto; }
.search input {
  font: inherit; font-size: 0.85rem; color: var(--ink);
  background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
  padding: 5px 10px; min-width: 0;
}
.search input[type="date"] { color: var(--ink-2); }
.search button {
  font: inherit; font-size: 0.85rem; cursor: pointer;
  background: var(--ink); color: var(--paper);
  border: 1px solid var(--ink); border-radius: 6px; padding: 5px 14px;
}
.search button:hover { background: var(--brass-ink); border-color: var(--brass-ink); }
.session-box { display: flex; align-items: center; gap: 10px; font-size: 0.8rem; color: var(--ink-3); }
.session-box form { margin: 0; }
.btn-ghost {
  font: inherit; font-size: 0.8rem; cursor: pointer;
  background: transparent; color: var(--ink-2);
  border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px;
}
.btn-ghost:hover { color: var(--ink); border-color: var(--ink-3); }

/* stats strip */
.stats { display: grid; grid-template-columns: repeat(4, 1fr); padding: 20px 0 26px; }
.stat { padding: 2px 20px; border-left: 1px solid var(--line); min-width: 0; }
.stat:first-child { border-left: none; padding-left: 0; }
.stat .num { font-family: var(--serif); font-size: 2rem; line-height: 1.15; font-variant-numeric: tabular-nums; }
.stat .num .unit { font-size: 0.95rem; color: var(--ink-2); margin-left: 2px; }
.stat .label { font-size: 0.72rem; letter-spacing: 0.1em; color: var(--ink-2); text-transform: uppercase; }
.stat .sub { font-family: var(--mono); font-size: 0.72rem; color: var(--ink-3); }

/* layout grid */
.grid { display: grid; grid-template-columns: minmax(0, 1fr) 316px; gap: 22px; align-items: start; }
.grid.pad-top { margin-top: 22px; }
.col-main { display: grid; gap: 22px; min-width: 0; }
.rail { display: grid; gap: 22px; min-width: 0; }

/* panels */
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--panel-shadow);
  padding: 18px 20px;
}
.panel > h2 {
  margin: 0 0 4px;
  font-family: var(--serif);
  font-size: 1.05rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.panel .panel-note { font-size: 0.76rem; color: var(--ink-3); margin: 0 0 12px; }
.panel-more { margin: 12px 0 0; font-size: 0.82rem; }
.panel-more a { color: var(--brass-ink); }

/* trend panel (将来の AI データの主役枠) */
.trend-empty { display: flex; align-items: flex-start; gap: 12px; padding: 8px 0 4px; }
.trend-empty .mark {
  flex: none; width: 34px; height: 34px; border-radius: 50%;
  border: 1px solid var(--brass); color: var(--brass-ink);
  display: grid; place-items: center;
  font-family: var(--serif); font-size: 1.05rem;
}
.trend-empty p { margin: 0; font-size: 0.86rem; color: var(--ink-2); }
.trend-empty .sub { font-size: 0.76rem; color: var(--ink-3); }

/* wire rail (signature): 夜間に流れた記事を時系列の電文として見せる */
.wire { list-style: none; margin: 6px 0 0; padding: 0; }
.wire li {
  position: relative;
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  gap: 12px;
  padding: 9px 0 9px 16px;
  border-left: 2px solid var(--line);
}
.wire li::before {
  content: "";
  position: absolute;
  left: -4px; top: 17px;
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--brass);
}
.wire .t { font-family: var(--mono); font-size: 0.76rem; color: var(--brass-ink); padding-top: 3px; }
.wire .headline { font-size: 0.95rem; line-height: 1.45; overflow-wrap: anywhere; }
.wire .src { display: block; font-size: 0.74rem; color: var(--ink-3); }

/* article rows */
.rows { list-style: none; margin: 8px 0 0; padding: 0; }
.rows li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 14px;
  padding: 9px 0;
  border-top: 1px solid var(--line-soft);
}
.rows li:first-child { border-top: none; }
.rows .headline { font-size: 0.92rem; line-height: 1.45; overflow-wrap: anywhere; }
.rows .src { display: block; font-size: 0.74rem; color: var(--ink-3); }
.rows .when { font-family: var(--mono); font-size: 0.74rem; color: var(--ink-3); white-space: nowrap; padding-top: 3px; }

/* feed status */
.feedlist { list-style: none; margin: 8px 0 0; padding: 0; }
.feedlist li { display: flex; align-items: baseline; gap: 8px; padding: 7px 0; border-top: 1px solid var(--line-soft); font-size: 0.85rem; }
.feedlist li:first-child { border-top: none; }
.dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--brass); align-self: center; }
.dot.off { background: transparent; border: 1px solid var(--ink-3); }
.feedlist .fname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.feedlist .fwhen { margin-left: auto; font-family: var(--mono); font-size: 0.72rem; color: var(--ink-3); white-space: nowrap; }

/* placeholder panel (将来のダイジェスト枠) */
.panel.slot { border-style: dashed; background: transparent; box-shadow: none; }
.panel.slot p { margin: 6px 0 0; font-size: 0.82rem; color: var(--ink-2); }

/* feeds page table */
.ftable { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 0.88rem; }
.ftable th {
  text-align: left; font-size: 0.7rem; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--ink-2); font-weight: 600; padding: 6px 10px; border-bottom: 1px solid var(--line);
}
.ftable td { padding: 9px 10px; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
.ftable .furl { font-family: var(--mono); font-size: 0.74rem; color: var(--ink-3); overflow-wrap: anywhere; }
.ftable .c { font-family: var(--mono); font-size: 0.78rem; white-space: nowrap; }
.flag { font-size: 0.78rem; }
.flag.on { color: var(--brass-ink); }
.flag.off { color: var(--ink-3); }
.table-scroll { overflow-x: auto; }
.row-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.row-actions form { margin: 0; display: inline; }

/* forms */
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; margin-top: 6px; }
.field { display: grid; gap: 4px; min-width: 0; }
.field.wide { grid-column: 1 / -1; }
.field label { font-size: 0.74rem; letter-spacing: 0.06em; color: var(--ink-2); text-transform: uppercase; }
.field .hint { font-size: 0.72rem; color: var(--ink-3); letter-spacing: 0; text-transform: none; }
.field input[type="text"], .field input[type="url"], .field input[type="number"],
.field input[type="password"], .field textarea {
  font: inherit; font-size: 0.9rem; color: var(--ink);
  background: var(--paper); border: 1px solid var(--line); border-radius: 6px;
  padding: 7px 10px; width: 100%;
}
.field textarea { resize: vertical; min-height: 60px; }
.check-row { display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: center; grid-column: 1 / -1; }
.check-row label { display: flex; gap: 7px; align-items: center; font-size: 0.86rem; color: var(--ink-2); cursor: pointer; }
.form-actions { grid-column: 1 / -1; display: flex; gap: 10px; align-items: center; margin-top: 4px; }
.btn {
  font: inherit; font-size: 0.86rem; cursor: pointer;
  background: var(--ink); color: var(--paper);
  border: 1px solid var(--ink); border-radius: 6px; padding: 7px 18px;
}
.btn:hover { background: var(--brass-ink); border-color: var(--brass-ink); }
.btn-small {
  font: inherit; font-size: 0.78rem; cursor: pointer;
  background: transparent; color: var(--ink-2);
  border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px;
}
.btn-small:hover { color: var(--ink); border-color: var(--ink-3); }
.btn-small.danger { color: var(--danger); }
.btn-small.danger:hover { border-color: var(--danger); }
.banner { border-radius: 8px; padding: 10px 14px; font-size: 0.86rem; margin: 14px 0 0; }
.banner.error { border: 1px solid var(--danger); color: var(--danger); }
.banner.notice { border: 1px solid var(--brass); color: var(--brass-ink); }

/* auth pages (login / setup) */
.auth-shell { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
.auth-card {
  width: 100%; max-width: 380px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
  box-shadow: var(--panel-shadow); padding: 30px 32px 26px;
}
/* ログイン画面のみ: 真鍮線の幾何学模様背景(/assets/login-bg.svg)とガラス質のカード */
.auth-shell.login {
  background-image: url('/assets/login-bg.svg');
  background-size: cover;
  background-position: center;
}
.auth-shell.login .auth-card {
  background: color-mix(in srgb, var(--panel) 86%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border-color: color-mix(in srgb, var(--brass) 40%, var(--line));
  box-shadow: 0 20px 60px rgba(28, 38, 55, 0.14);
}
.auth-card .brand { font-size: 1.5rem; margin: 0 0 2px; }
.auth-card .auth-sub { font-size: 0.8rem; color: var(--ink-3); margin: 0 0 18px; }
.auth-card .field { margin-top: 12px; }
.auth-card .btn { width: 100%; margin-top: 18px; padding: 9px 18px; }

.empty { padding: 18px 0 8px; font-size: 0.85rem; color: var(--ink-2); }
.result-note { font-size: 0.82rem; color: var(--ink-2); margin: 2px 0 0; }

footer.colophon {
  margin-top: 30px; padding-top: 14px; border-top: 1px solid var(--line);
  display: flex; flex-wrap: wrap; gap: 6px 18px;
  font-family: var(--mono); font-size: 0.7rem; color: var(--ink-3);
}

@media (prefers-reduced-motion: no-preference) {
  .shell { animation: rise 0.28s ease-out; }
  @keyframes rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
}
@media (max-width: 940px) {
  .grid { grid-template-columns: 1fr; }
  .stats { grid-template-columns: repeat(2, 1fr); gap: 14px 0; }
  .stat:nth-child(3) { border-left: none; padding-left: 0; }
  .masthead-meta { flex-basis: 100%; margin-left: 0; }
  .search { margin-left: 0; flex-basis: 100%; }
  .search input[type="text"] { flex: 1; }
  .form-grid { grid-template-columns: 1fr; }
}
`;

/* ------------------------------------------------------------- rendering */

export type NavKey = 'dashboard' | 'articles' | 'feeds';

export interface PageContext {
  now: Date;
  activeNav: NavKey;
  /** ログイン中のユーザー名(ツールバー表示・ログアウトボタン用)。 */
  username: string;
  query?: { q: string; date: string };
}

function htmlDocument(title: string, body: string, extraScripts = ''): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
<script src="/assets/htmx.min.js" defer></script>${extraScripts}
</head>
<body hx-boost="true">
${body}
</body>
</html>`;
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
  <span>時刻はすべて日本時間(JST)</span>
</footer>
</div>`,
    '\n<script src="/assets/clock.js" defer></script>',
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
    opts.login ? '\n<script src="/assets/login.js" defer></script>' : '',
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

function statsStrip(input: {
  last24Count: number;
  feeds: Feed[];
  lastFetched: Date | null;
}): string {
  const enabled = input.feeds.filter((f) => f.enabled).length;
  const fulltext = input.feeds.filter((f) => f.fulltextAllowed).length;
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
  </div>
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

export function dashboardBody(input: { last24: Article[]; feeds: Feed[] }): string {
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
  return `${statsStrip({ last24Count: input.last24.length, feeds: input.feeds, lastFetched })}
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
}): string {
  const feedsById = new Map(input.feeds.map((f) => [f.id, f]));
  const hasFilter = input.q !== '' || input.date !== '' || input.feedId !== '';
  const parts: string[] = [];
  if (input.q !== '') parts.push(`「${escapeHtml(input.q)}」を含むタイトル`);
  if (input.date !== '') parts.push(`${escapeHtml(input.date)}(JST)公開`);
  if (input.feedId !== '') {
    const feed = feedsById.get(input.feedId);
    parts.push(`フィード: ${escapeHtml(feed?.name ?? input.feedId)}`);
  }
  const note = hasFilter
    ? `${parts.join(' / ')} — ${input.articles.length}件`
    : `公開日時の新しい順(JST) — ${input.articles.length}件`;
  const rows =
    input.articles.length === 0
      ? `<p class="empty">${hasFilter ? '該当する記事はありません。条件を変えて検索してください。' : '記事がまだありません。フィードを登録して収集を実行してください。'}</p>`
      : `<ul class="rows">\n${input.articles.map((a) => rowItem(a, feedsById)).join('\n')}\n</ul>`;
  return `<main class="grid pad-top">
  <div class="col-main">
    <section class="panel">
      <h2>${hasFilter ? '検索結果' : '記事一覧'}</h2>
      <p class="result-note">${note}</p>
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
  };
}

function feedFormFields(values: FeedFormValues): string {
  const checked = (b: boolean) => (b ? ' checked' : '');
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
  const rows = input.feeds
    .map(
      (f) => `<tr>
<td>${escapeHtml(f.name)}<div class="furl">${escapeHtml(f.feedUrl)}</div></td>
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
  return `<main style="margin-top:22px">
${input.error ? `<div class="banner error" role="alert">${escapeHtml(input.error)}</div>` : ''}
${input.notice ? `<div class="banner notice">${escapeHtml(input.notice)}</div>` : ''}
<section class="panel" style="margin-top:14px">
<h2>フィードを追加</h2>
<p class="panel-note">RSS / Atom フィードの URL を登録すると次回の収集から対象になります</p>
<form method="post" action="/feeds" class="form-grid">
${feedFormFields(form)}
<div class="form-actions"><button type="submit" class="btn">追加する</button></div>
</form>
</section>
<section class="panel" style="margin-top:22px">
<h2>フィード一覧</h2>
<p class="panel-note">収集対象の情報源と規約フラグ</p>
<div class="table-scroll">
<table class="ftable">
<thead><tr><th>名前 / URL</th><th>状態</th><th>本文取得</th><th>間隔</th><th>最終取得 (JST)</th><th>操作</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="6" class="empty">フィードが未登録です</td></tr>'}
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
}): string {
  const form = input.form ?? feedToFormValues(input.feed);
  return `<main style="margin-top:22px">
${input.error ? `<div class="banner error" role="alert">${escapeHtml(input.error)}</div>` : ''}
<section class="panel" style="margin-top:14px">
<h2>フィードを編集</h2>
<p class="panel-note">${escapeHtml(input.feed.name)} — 最終取得: ${fmtDateTimeJst(input.feed.lastFetchedAt)}</p>
<form method="post" action="/feeds/${escapeHtml(input.feed.id)}" class="form-grid">
${feedFormFields(form)}
<div class="form-actions">
  <button type="submit" class="btn">保存する</button>
  <a class="btn-small" href="/feeds">一覧へ戻る</a>
</div>
</form>
</section>
</main>`;
}

/* -------------------------------------------------------- auth pages */

export function loginBody(input: { error?: string; notice?: string } = {}): string {
  // data-login-alert: /assets/login.js が読み取り window.alert を出す。
  // 文言はどのフィールドが誤りかを判別できないものだけを渡すこと(ユーザー列挙対策)。
  return `${input.error ? `<div class="banner error" role="alert" data-login-alert="${escapeHtml(input.error)}">${escapeHtml(input.error)}</div>` : ''}
${input.notice ? `<div class="banner notice">${escapeHtml(input.notice)}</div>` : ''}
<form method="post" action="/login">
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

export function setupBody(input: { error?: string; username?: string } = {}): string {
  return `${input.error ? `<div class="banner error" role="alert">${escapeHtml(input.error)}</div>` : ''}
<p style="font-size:0.86rem;color:var(--ink-2);margin:0 0 4px">初回セットアップ: 管理ユーザーを作成してください。</p>
<form method="post" action="/setup">
  <div class="field">
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
    `<main><section class="panel" style="margin-top:22px"><h2>${escapeHtml(heading)}</h2><p class="result-note">${escapeHtml(message)}</p></section></main>`,
  );
}
