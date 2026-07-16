import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repositories } from '../domain/repositories.ts';
import type { Article, Feed } from '../domain/types.ts';
import { verifyBasicPassword } from './auth.ts';

/**
 * 緊急時・日常確認用の read-only ダッシュボード(ブラウザ向け)。
 * 「朝刊ワイヤー」— 海外の夜間に動いた情報を朝いちばんに一望する。
 * 書き込み操作は持たない(管理 UI = T4-1 は未決事項 U3 の確定後)。
 */
export interface UiDeps {
  repos: Repositories;
  uiPassword: string;
  now?: () => Date;
}

function escapeHtml(value: string): string {
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
function safeHttpUrl(raw: string): string | null {
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
function isRealDate(date: string): boolean {
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

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'] as const;

function utcDateStamp(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function jaDate(d: Date): string {
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日(${WEEKDAYS_JA[d.getUTCDay()]})`;
}

function hhmm(d: Date): string {
  return d.toISOString().slice(11, 16);
}

function fmtDateTime(date: Date | null): string {
  return date === null ? '—' : `${date.toISOString().slice(0, 10)} ${hhmm(date)}Z`;
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
a:focus-visible, button:focus-visible, input:focus-visible {
  outline: 2px solid var(--brass);
  outline-offset: 2px;
  border-radius: 2px;
}
.shell { max-width: 1160px; margin: 0 auto; padding: 0 20px 56px; }

/* masthead */
.masthead { padding: 26px 0 18px; border-bottom: 1px solid var(--ink); }
.masthead-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 18px; }
.brand { font-family: var(--serif); font-size: 1.7rem; font-weight: 600; letter-spacing: 0.01em; margin: 0; }
.brand .kicker { color: var(--brass-ink); }
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
.wire li:first-child { border-top: none; }
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

/* placeholder panel (将来のトレンド/ダイジェスト枠) */
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
}
`;

/* ------------------------------------------------------------- rendering */

interface PageContext {
  now: Date;
  activeNav: 'articles' | 'feeds';
  query?: { q: string; date: string };
}

function layout(title: string, ctx: PageContext, body: string): string {
  const q = ctx.query?.q ?? '';
  const date = ctx.query?.date ?? '';
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="shell">
<header class="masthead">
  <div class="masthead-row">
    <h1 class="brand"><span class="kicker">朝刊</span> Morning Wire</h1>
    <span class="masthead-date">${jaDate(ctx.now)}</span>
    <span class="masthead-meta">PERSONAL RSS READER · ${hhmm(ctx.now)} UTC</span>
  </div>
  <div class="toolbar">
    <nav class="nav" aria-label="ページ">
      <a href="/ui"${ctx.activeNav === 'articles' ? ' aria-current="page"' : ''}>記事</a>
      <a href="/ui/feeds"${ctx.activeNav === 'feeds' ? ' aria-current="page"' : ''}>フィード</a>
    </nav>
    <form class="search" method="get" action="/ui">
      <input type="text" name="q" placeholder="タイトルを検索" value="${escapeHtml(q)}" aria-label="タイトル検索">
      <input type="date" name="date" value="${escapeHtml(date)}" aria-label="日付で絞り込み">
      <button type="submit">表示</button>
    </form>
  </div>
</header>
${body}
<footer class="colophon">
  <span>時刻はすべて UTC</span>
  <span>タイトル・URL・公開日時のみ保存</span>
  <span>収集はサーバー側の due 判定で冪等</span>
</footer>
</div>
</body>
</html>`;
}

function wireItem(article: Article, feedsById: Map<string, Feed>): string {
  const feed = feedsById.get(article.feedId);
  const href = safeHttpUrl(article.url);
  const title =
    href === null
      ? escapeHtml(article.title)
      : `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${escapeHtml(article.title)}</a>`;
  const t =
    article.publishedAt === null
      ? '--:--'
      : `${article.publishedAt.toISOString().slice(5, 10)} ${hhmm(article.publishedAt)}`;
  return `<li>
<span class="t">${t}</span>
<span class="headline">${title}<span class="src">${escapeHtml(feed?.name ?? article.feedId)}</span></span>
</li>`;
}

function rowItem(article: Article, feedsById: Map<string, Feed>): string {
  const feed = feedsById.get(article.feedId);
  const href = safeHttpUrl(article.url);
  const title =
    href === null
      ? escapeHtml(article.title)
      : `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${escapeHtml(article.title)}</a>`;
  return `<li>
<span class="headline">${title}<span class="src">${escapeHtml(feed?.name ?? article.feedId)}</span></span>
<span class="when">${article.publishedAt === null ? '—' : fmtDateTime(article.publishedAt)}</span>
</li>`;
}

function statsStrip(input: {
  todayCount: number;
  feeds: Feed[];
  lastFetched: Date | null;
}): string {
  const enabled = input.feeds.filter((f) => f.enabled).length;
  const fulltext = input.feeds.filter((f) => f.fulltextAllowed).length;
  return `<section class="stats" aria-label="概況">
  <div class="stat">
    <div class="num">${input.todayCount}<span class="unit">件</span></div>
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
    <div class="num">${input.lastFetched === null ? '—' : hhmm(input.lastFetched)}</div>
    <div class="label">最終取得</div>
    <div class="sub">${input.lastFetched === null ? 'まだ収集していません' : `${utcDateStamp(input.lastFetched)} UTC`}</div>
  </div>
</section>`;
}

function feedRail(feeds: Feed[]): string {
  const items = feeds
    .map(
      (f) => `<li>
<span class="dot${f.enabled ? '' : ' off'}" aria-hidden="true"></span>
<span class="fname">${escapeHtml(f.name)}</span>
<span class="fwhen">${f.lastFetchedAt === null ? '未取得' : hhmm(f.lastFetchedAt) + 'Z'}</span>
</li>`,
    )
    .join('\n');
  return `<section class="panel">
<h2>フィードの状態</h2>
<p class="panel-note">収集済みの情報源と最終取得時刻</p>
<ul class="feedlist">
${items || '<li>フィードが未登録です</li>'}
</ul>
</section>`;
}

const TREND_SLOT = `<section class="panel slot">
<h2>今日のトレンド</h2>
<p>MCP クライアント(Claude / ChatGPT)で分析すると、ここにトピック抽出と朝刊ダイジェストが表示されます。準備中(未決事項 U6)。</p>
</section>`;

const WIRE_MAX = 12;

function dashboardBody(input: {
  last24: Article[];
  recent: Article[];
  feeds: Feed[];
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
      ? '<p class="empty">直近24時間の記事はまだありません。収集はトリガー実行時の due 判定で行われます。</p>'
      : `<ol class="wire">\n${wireItems.map((a) => wireItem(a, feedsById)).join('\n')}\n</ol>`;
  const rows =
    input.recent.length === 0
      ? '<p class="empty">記事がまだありません。フィードを登録して収集を実行してください。</p>'
      : `<ul class="rows">\n${input.recent.map((a) => rowItem(a, feedsById)).join('\n')}\n</ul>`;
  return `${statsStrip({ todayCount: input.last24.length, feeds: input.feeds, lastFetched })}
<main class="grid">
  <div class="col-main">
    <section class="panel">
      <h2>今朝の見出し</h2>
      <p class="panel-note">直近24時間(UTC)に公開された記事 — 新着順${input.last24.length > WIRE_MAX ? ` · 上位${WIRE_MAX}件` : ''}</p>
      ${wire}
    </section>
    <section class="panel">
      <h2>最近の記事</h2>
      <p class="panel-note">公開日時の新しい順</p>
      ${rows}
    </section>
  </div>
  <aside class="rail">
    ${feedRail(input.feeds)}
    ${TREND_SLOT}
  </aside>
</main>`;
}

function resultsBody(input: {
  articles: Article[];
  feeds: Feed[];
  q: string;
  date: string;
  feedId: string;
}): string {
  const feedsById = new Map(input.feeds.map((f) => [f.id, f]));
  const parts: string[] = [];
  if (input.q !== '') parts.push(`「${escapeHtml(input.q)}」を含むタイトル`);
  if (input.date !== '') parts.push(`${escapeHtml(input.date)}(UTC)公開`);
  if (input.feedId !== '') {
    const feed = feedsById.get(input.feedId);
    parts.push(`フィード: ${escapeHtml(feed?.name ?? input.feedId)}`);
  }
  const rows =
    input.articles.length === 0
      ? '<p class="empty">該当する記事はありません。条件を変えて検索してください。</p>'
      : `<ul class="rows">\n${input.articles.map((a) => rowItem(a, feedsById)).join('\n')}\n</ul>`;
  return `<main class="grid" style="margin-top:22px">
  <div class="col-main">
    <section class="panel">
      <h2>検索結果</h2>
      <p class="result-note">${parts.join(' / ')} — ${input.articles.length}件</p>
      ${rows}
    </section>
  </div>
  <aside class="rail">
    ${feedRail(input.feeds)}
    ${TREND_SLOT}
  </aside>
</main>`;
}

function feedsBody(feeds: Feed[]): string {
  const rows = feeds
    .map(
      (f) => `<tr>
<td>${escapeHtml(f.name)}<div class="furl">${escapeHtml(f.feedUrl)}</div></td>
<td><span class="flag ${f.enabled ? 'on' : 'off'}">${f.enabled ? '● 有効' : '○ 無効'}</span></td>
<td><span class="flag ${f.fulltextAllowed ? 'on' : 'off'}">${f.fulltextAllowed ? '可' : '不可'}</span></td>
<td class="c">${f.fetchIntervalMinutes}分</td>
<td class="c">${fmtDateTime(f.lastFetchedAt)}</td>
<td><a href="/ui?feed=${escapeHtml(f.id)}">記事</a></td>
</tr>`,
    )
    .join('\n');
  return `<main style="margin-top:22px">
<section class="panel">
<h2>フィード一覧</h2>
<p class="panel-note">収集対象の情報源と規約フラグ</p>
<div class="table-scroll">
<table class="ftable">
<thead><tr><th>名前 / URL</th><th>状態</th><th>本文取得</th><th>間隔</th><th>最終取得 (UTC)</th><th></th></tr></thead>
<tbody>
${rows || '<tr><td colspan="6" class="empty">フィードが未登録です</td></tr>'}
</tbody>
</table>
</div>
</section>
</main>`;
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

/* --------------------------------------------------------------- handler */

/** GET /ui, /ui/feeds を処理。認証失敗時はブラウザの Basic 認証プロンプトを出す。 */
export async function handleUi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: UiDeps,
): Promise<void> {
  const auth = req.headers['authorization'];
  const authValue = Array.isArray(auth) ? auth[0] : auth;
  if (!verifyBasicPassword(authValue, deps.uiPassword)) {
    res.writeHead(401, {
      'www-authenticate': 'Basic realm="personal-rss-reader", charset="UTF-8"',
      'content-type': 'text/plain; charset=utf-8',
    });
    res.end('authentication required');
    return;
  }

  const now = (deps.now ?? (() => new Date()))();
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (path === '/ui/feeds') {
    const feeds = await deps.repos.feeds.list();
    sendHtml(
      res,
      200,
      layout('フィード一覧 — Morning Wire', { now, activeNav: 'feeds' }, feedsBody(feeds)),
    );
    return;
  }

  if (path === '/ui' || path === '/ui/') {
    const q = url.searchParams.get('q')?.trim() ?? '';
    const date = url.searchParams.get('date')?.trim() ?? '';
    const feedId = url.searchParams.get('feed')?.trim() ?? '';
    const ctx: PageContext = { now, activeNav: 'articles', query: { q, date } };
    if (date !== '' && !isRealDate(date)) {
      sendHtml(
        res,
        400,
        layout('不正なリクエスト', ctx, '<main><section class="panel" style="margin-top:22px"><h2>不正なリクエスト</h2><p class="result-note">date は実在する日付を YYYY-MM-DD 形式で指定してください。</p></section></main>'),
      );
      return;
    }
    if (feedId !== '' && !UUID_RE.test(feedId)) {
      sendHtml(
        res,
        400,
        layout('不正なリクエスト', ctx, '<main><section class="panel" style="margin-top:22px"><h2>不正なリクエスト</h2><p class="result-note">feed の形式が不正です。</p></section></main>'),
      );
      return;
    }

    const feeds = await deps.repos.feeds.list();
    const hasFilter = q !== '' || date !== '' || feedId !== '';

    if (!hasFilter) {
      const since = new Date(now.getTime() - 24 * 60 * 60_000);
      const [last24, recent] = await Promise.all([
        deps.repos.articles.listRecent({ since, limit: 200 }),
        deps.repos.articles.listRecent({ limit: 30 }),
      ]);
      sendHtml(res, 200, layout('朝刊 — Morning Wire', ctx, dashboardBody({ last24, recent, feeds })));
      return;
    }

    let articles: Article[];
    if (q !== '') {
      articles = await deps.repos.articles.searchByTitle(
        q,
        feedId !== '' ? { limit: 200, feedId } : { limit: 200 },
      );
    } else if (date !== '') {
      articles = await deps.repos.articles.listByDate(date);
    } else {
      articles = await deps.repos.articles.listRecent({ feedId, limit: 200 });
    }
    if (feedId !== '') {
      articles = articles.filter((a) => a.feedId === feedId);
    }
    sendHtml(
      res,
      200,
      layout('検索結果 — Morning Wire', ctx, resultsBody({ articles, feeds, q, date, feedId })),
    );
    return;
  }

  sendHtml(
    res,
    404,
    layout('Not Found', { now, activeNav: 'articles' }, '<main><section class="panel" style="margin-top:22px"><h2>ページが見つかりません</h2><p class="result-note"><a href="/ui">記事一覧へ戻る</a></p></section></main>'),
  );
}
