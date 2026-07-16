import type { Repositories } from '../domain/repositories.ts';
import { assertPublicHttpUrl, type LookupFn } from '../server/ssrf.ts';

/** テストから注入できる fetch。既定はグローバル fetch。 */
export type FetchFn = (
  url: string,
  init: {
    redirect: 'manual';
    signal: AbortSignal;
    headers: Record<string, string>;
  },
) => Promise<FetchResponse>;

/** fetch の戻り値のうち本モジュールが使う部分だけを型付け。 */
export interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FetchContentDeps {
  repos: Repositories;
  cacheFulltext: boolean;
  fetchFn: FetchFn;
  lookupFn: LookupFn;
  now: () => Date;
  userAgent: string;
}

const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 500 * 1024; // 500KB
const MAX_TEXT_CHARS = 100 * 1024; // 100KB
const HOST_MIN_INTERVAL_MS = 10_000; // 同一ホスト 10 秒に 1 回

/** 本文取得の拒否/失敗。理由に内部パスやトークンは含めない。 */
export class FetchContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchContentError';
  }
}

// ホスト単位レートリミット(プロセス内で共有。ステートレスな MCP リクエスト間で持続させる)。
const lastFetchByHost = new Map<string, number>();

/** テスト用: レートリミッタの状態を消去。 */
export function resetHostRateLimiter(): void {
  lastFetchByHost.clear();
}

function enforceHostRateLimit(host: string, nowMs: number): void {
  const last = lastFetchByHost.get(host);
  if (last !== undefined && nowMs - last < HOST_MIN_INTERVAL_MS) {
    throw new FetchContentError('rate limited for this host; retry later');
  }
  lastFetchByHost.set(host, nowMs);
}

async function readCapped(res: FetchResponse, maxBytes: number): Promise<Buffer> {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.subarray(0, maxBytes);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total >= maxBytes) break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 中断時のエラーは無視。
    }
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/** HTML から script/style を除き、タグ除去・エンティティ最低限デコードしたプレーンテキスト。 */
export function htmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, ' ');
  return decodeEntities(withoutTags).replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

export interface FetchContentResult {
  articleId: string;
  url: string;
  content: string;
  cached: boolean;
}

/**
 * DB 登録済み記事の本文をオンデマンド取得(設計書 §6 の制約を全て実装)。
 * fulltext_allowed=false のフィードでは決して取得しない。
 */
export async function fetchArticleContent(
  deps: FetchContentDeps,
  articleId: string,
): Promise<FetchContentResult> {
  const article = await deps.repos.articles.getById(articleId);
  if (article === null) {
    throw new FetchContentError('article not found');
  }
  const feed = await deps.repos.feeds.getById(article.feedId);
  if (feed === null) {
    throw new FetchContentError('feed not found for article');
  }
  // 絶対条件: 許可のないフィードの本文取得コードパスに入らない。
  if (!feed.fulltextAllowed) {
    throw new FetchContentError('fulltext fetching is not allowed for this source');
  }

  // URL は入力から受け取らず、DB に保存済みの article.url のみを使う。
  const originalUrl = article.url;
  let originalHost: string;
  try {
    originalHost = new URL(originalUrl).hostname;
  } catch {
    throw new FetchContentError('stored article URL is invalid');
  }

  enforceHostRateLimit(originalHost, deps.now().getTime());

  let currentUrl = originalUrl;
  let redirects = 0;
  let response: FetchResponse | null = null;

  for (;;) {
    // 各ホップで再度 SSRF 検証。
    const parsed = await assertPublicHttpUrl(currentUrl, deps.lookupFn);
    // リダイレクトは同一ホストのみ許可。
    if (parsed.hostname !== originalHost) {
      throw new FetchContentError('redirect to a different host is not allowed');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: FetchResponse;
    try {
      res = await deps.fetchFn(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': deps.userAgent, accept: 'text/html, text/plain' },
      });
    } catch {
      throw new FetchContentError('failed to fetch article content');
    } finally {
      clearTimeout(timer);
    }

    const status = res.status;
    if (status >= 300 && status < 400 && status !== 304) {
      if (redirects >= MAX_REDIRECTS) {
        throw new FetchContentError('too many redirects');
      }
      const location = res.headers.get('location');
      if (location === null || location.length === 0) {
        response = res;
        break;
      }
      try {
        await res.body?.cancel?.();
      } catch {
        // ignore
      }
      let next: URL;
      try {
        next = new URL(location, currentUrl);
      } catch {
        throw new FetchContentError('invalid redirect location');
      }
      currentUrl = next.toString();
      redirects += 1;
      continue;
    }

    response = res;
    break;
  }

  if (response === null) {
    throw new FetchContentError('failed to fetch article content');
  }
  if (response.status < 200 || response.status >= 300) {
    throw new FetchContentError('upstream returned an error status');
  }

  const buf = await readCapped(response, MAX_RESPONSE_BYTES);
  const contentType = response.headers.get('content-type') ?? '';
  const raw = buf.toString('utf8');
  const isHtml = /html/i.test(contentType) || (contentType === '' && /<[a-z!][\s\S]*>/i.test(raw));
  let text = isHtml ? htmlToText(raw) : raw.trim();
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
  }

  // 既定では永続化しない。cacheFulltext=true のときのみ setContent。
  let cached = false;
  if (deps.cacheFulltext) {
    await deps.repos.articles.setContent(article.id, text);
    cached = true;
  }

  return { articleId: article.id, url: originalUrl, content: text, cached };
}
