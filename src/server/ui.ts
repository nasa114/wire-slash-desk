import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repositories } from '../domain/repositories.ts';
import type { Article, Feed } from '../domain/types.ts';
import { verifyBasicPassword } from './auth.ts';

/**
 * 緊急時・日常確認用の最小 read-only UI(ブラウザ向け非常口)。
 * MCP クライアントが使えない状況でも収集状況と記事を確認できるようにする。
 * 書き込み操作は持たない(管理 UI = T4-1 は未決事項 U3 の確定後)。
 */
export interface UiDeps {
  repos: Repositories;
  uiPassword: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmt(date: Date | null): string {
  return date === null ? '—' : date.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 1.5rem auto; max-width: 60rem; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.2rem; }
  nav a { margin-right: 1rem; }
  form { margin: 0.5rem 0 1rem; }
  input[type=text], input[type=date] { padding: 0.25rem 0.5rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid #ddd; vertical-align: top; }
  .meta { color: #666; font-size: 0.85rem; white-space: nowrap; }
  .flag-on { color: #0a7d32; } .flag-off { color: #999; }
</style>
</head>
<body>
<nav><a href="/ui">記事</a><a href="/ui/feeds">フィード</a></nav>
${body}
</body>
</html>`;
}

function articlesBody(
  articles: Article[],
  feedsById: Map<string, Feed>,
  query: { q: string; date: string; feed: string },
): string {
  const rows = articles
    .map((a) => {
      const feed = feedsById.get(a.feedId);
      return `<tr>
<td><a href="${escapeHtml(a.url)}" rel="noopener noreferrer">${escapeHtml(a.title)}</a><br>
<span class="meta">${escapeHtml(feed?.name ?? a.feedId)}</span></td>
<td class="meta">${fmt(a.publishedAt)}</td>
</tr>`;
    })
    .join('\n');
  return `<h1>記事一覧</h1>
<form method="get" action="/ui">
  <input type="text" name="q" placeholder="タイトル検索" value="${escapeHtml(query.q)}">
  <input type="date" name="date" value="${escapeHtml(query.date)}">
  <button type="submit">絞り込み</button>
  <a href="/ui">クリア</a>
</form>
<table>
<thead><tr><th>タイトル / フィード</th><th>公開日時 (UTC)</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="2">記事がありません</td></tr>'}
</tbody>
</table>`;
}

function feedsBody(feeds: Feed[]): string {
  const rows = feeds
    .map(
      (f) => `<tr>
<td>${escapeHtml(f.name)}<br><span class="meta">${escapeHtml(f.feedUrl)}</span></td>
<td>${f.enabled ? '<span class="flag-on">有効</span>' : '<span class="flag-off">無効</span>'}</td>
<td>${f.fulltextAllowed ? '<span class="flag-on">可</span>' : '<span class="flag-off">不可</span>'}</td>
<td class="meta">${f.fetchIntervalMinutes}分</td>
<td class="meta">${fmt(f.lastFetchedAt)}</td>
<td><a href="/ui?feed=${escapeHtml(f.id)}">記事</a></td>
</tr>`,
    )
    .join('\n');
  return `<h1>フィード一覧</h1>
<table>
<thead><tr><th>名前 / URL</th><th>状態</th><th>本文取得</th><th>間隔</th><th>最終取得 (UTC)</th><th></th></tr></thead>
<tbody>
${rows || '<tr><td colspan="6">フィードがありません</td></tr>'}
</tbody>
</table>`;
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (path === '/ui/feeds') {
    const feeds = await deps.repos.feeds.list();
    sendHtml(res, 200, layout('フィード一覧', feedsBody(feeds)));
    return;
  }

  if (path === '/ui' || path === '/ui/') {
    const q = url.searchParams.get('q')?.trim() ?? '';
    const date = url.searchParams.get('date')?.trim() ?? '';
    const feedId = url.searchParams.get('feed')?.trim() ?? '';
    if (date !== '' && !DATE_RE.test(date)) {
      sendHtml(res, 400, layout('不正なリクエスト', '<h1>date は YYYY-MM-DD 形式で指定してください</h1>'));
      return;
    }
    if (feedId !== '' && !UUID_RE.test(feedId)) {
      sendHtml(res, 400, layout('不正なリクエスト', '<h1>feed の形式が不正です</h1>'));
      return;
    }

    let articles: Article[];
    if (q !== '') {
      articles = await deps.repos.articles.searchByTitle(q, 200);
    } else if (date !== '') {
      articles = await deps.repos.articles.listByDate(date);
    } else {
      articles = await deps.repos.articles.listRecent(
        feedId !== '' ? { feedId, limit: 200 } : { limit: 200 },
      );
    }
    if (feedId !== '') {
      articles = articles.filter((a) => a.feedId === feedId);
    }

    const feeds = await deps.repos.feeds.list();
    const feedsById = new Map(feeds.map((f) => [f.id, f]));
    sendHtml(res, 200, layout('記事一覧', articlesBody(articles, feedsById, { q, date, feed: feedId })));
    return;
  }

  sendHtml(res, 404, layout('Not Found', '<h1>ページが見つかりません</h1>'));
}
