import Parser from 'rss-parser';
import type { Feed } from '../domain/types.ts';
import type { Repositories } from '../domain/repositories.ts';
import {
  assertProxySafeHttpUrl,
  assertPublicHttpUrl,
  defaultLookup,
  type LookupFn,
} from '../server/ssrf.ts';
import { mapFeedItemToArticle } from './map.ts';
import { runWithConcurrency } from './pool.ts';

const DEFAULT_USER_AGENT =
  'personal-rss-reader/0.1 (+https://github.com/example/personal-rss-reader)';
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
// フィード応答の読み取り上限(悪意/侵害フィードによるメモリ枯渇 DoS 対策)。
// 一般的な RSS/Atom は数百KB以内。fetch-content の 500KB より緩めの 5MB を採る。
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const ACCEPT_HEADER =
  'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5';

export interface CollectOptions {
  repos: Repositories;
  /** 既定 globalThis.fetch。テストでは fake を注入する(ネットワークアクセス禁止)。 */
  fetchFn?: typeof fetch;
  /** 既定 () => new Date()。テストでは決定的な時刻を注入する。 */
  now?: () => Date;
  /** 既定 4。フィード取得の同時実行数(設計書 §5-5)。 */
  concurrency?: number;
  /** 既定 10_000。1フィードあたりのタイムアウト(設計書 §5-5)。 */
  timeoutMs?: number;
  /** 既定は連絡先つきUA(設計書 §5-5)。 */
  userAgent?: string;
  /**
   * SSRF ガードのホスト名解決関数。既定は node:dns。テストで注入して実 DNS を避ける。
   * 設計書 §6 の SSRF 対策を feed 取得経路にも適用する。
   */
  lookupFn?: LookupFn;
  /**
   * egress プロキシ信頼モード(src/config.ts trustEgressProxy 参照)。既定 false。
   * true のときは DNS 事前解決を行わず、IP リテラルのみ検査する(接続先制御は
   * プロキシ許可リストへ委譲。fetch-content と同じ方針)。
   */
  trustEgressProxy?: boolean;
}

export interface FeedCollectResult {
  feedId: string;
  name: string;
  status: 'ok' | 'not_modified' | 'error';
  inserted: number;
  skipped: number;
  error?: string;
}

export interface CollectResult {
  startedAt: string;
  feeds: FeedCollectResult[];
  totalInserted: number;
  totalSkipped: number;
}

interface FeedContext {
  repos: Repositories;
  fetchFn: typeof fetch;
  now: () => Date;
  timeoutMs: number;
  userAgent: string;
  lookupFn: LookupFn;
  trustEgressProxy: boolean;
}

/**
 * due なフィードを条件付きGETで取得し、タイトル/URL/公開日時/guid のみを
 * upsertMany する(設計書 §5)。本文系フィールドは map.ts の時点で破棄済み。
 */
export async function collectDueFeeds(options: CollectOptions): Promise<CollectResult> {
  const {
    repos,
    fetchFn = globalThis.fetch,
    now = () => new Date(),
    concurrency = DEFAULT_CONCURRENCY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    userAgent = DEFAULT_USER_AGENT,
    lookupFn = defaultLookup,
    trustEgressProxy = false,
  } = options;

  const startedAt = now();
  const dueFeeds = await repos.feeds.listDue(startedAt);

  const ctx: FeedContext = { repos, fetchFn, now, timeoutMs, userAgent, lookupFn, trustEgressProxy };
  const feeds = await runWithConcurrency(dueFeeds, concurrency, (feed) => collectFeed(feed, ctx));

  let totalInserted = 0;
  let totalSkipped = 0;
  for (const result of feeds) {
    totalInserted += result.inserted;
    totalSkipped += result.skipped;
  }

  return {
    startedAt: startedAt.toISOString(),
    feeds,
    totalInserted,
    totalSkipped,
  };
}

/**
 * SSRF ガードつきで feed を取得する(設計書 §6 を collector 経路へ適用)。
 * - 各ホップで公開アドレス検査(プロキシ信頼モードでは IP リテラルのみ検査)
 * - リダイレクトは自動追従せず手動処理し、ホップごとに再検査(TOCTOU 面を縮小)
 * - 回数制限つき。プライベート宛ては assert が SsrfError を投げて弾く
 */
async function fetchFeedGuarded(
  feed: Feed,
  ctx: FeedContext,
  conditionalHeaders: Record<string, string>,
): Promise<Response> {
  let currentUrl = feed.feedUrl;
  let redirects = 0;
  for (;;) {
    // 接続先が公開アドレスであることを毎ホップ検証(プライベートなら SsrfError)。
    if (ctx.trustEgressProxy) {
      assertProxySafeHttpUrl(currentUrl);
    } else {
      await assertPublicHttpUrl(currentUrl, ctx.lookupFn);
    }

    const headers: Record<string, string> =
      redirects === 0
        ? conditionalHeaders
        : { 'User-Agent': ctx.userAgent, Accept: ACCEPT_HEADER };

    const res = await ctx.fetchFn(currentUrl, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });

    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      if (redirects >= MAX_REDIRECTS) throw new Error('too_many_redirects');
      const location = res.headers.get('location');
      if (location === null || location.length === 0) return res;
      try {
        await res.body?.cancel?.();
      } catch {
        // ignore
      }
      let next: URL;
      try {
        next = new URL(location, currentUrl);
      } catch {
        throw new Error('invalid_redirect_location');
      }
      currentUrl = next.toString();
      redirects += 1;
      continue;
    }
    return res;
  }
}

/** 応答本文を上限バイト数で打ち切って読む(メモリ枯渇 DoS 対策)。 */
async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.subarray(0, maxBytes).toString('utf8');
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
      // ignore
    }
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
}

async function collectFeed(feed: Feed, ctx: FeedContext): Promise<FeedCollectResult> {
  const base = { feedId: feed.id, name: feed.name };
  try {
    const headers: Record<string, string> = {
      'User-Agent': ctx.userAgent,
      Accept: ACCEPT_HEADER,
    };
    if (feed.etag) headers['If-None-Match'] = feed.etag;
    if (feed.lastModified) headers['If-Modified-Since'] = feed.lastModified;

    const response = await fetchFeedGuarded(feed, ctx, headers);

    if (response.status === 304) {
      await ctx.repos.feeds.markFetched(feed.id, ctx.now());
      return { ...base, status: 'not_modified', inserted: 0, skipped: 0 };
    }

    if (!response.ok) {
      throw new Error(`http_${response.status}`);
    }

    const xml = await readTextCapped(response, MAX_FEED_BYTES);
    const parser = new Parser<{ language?: string }>();
    const parsed = await parser.parseString(xml);
    const feedLang = parsed.language ?? null;

    const articles = [];
    for (const item of parsed.items) {
      const mapped = mapFeedItemToArticle(feed.id, item, feedLang);
      if (mapped) articles.push(mapped);
    }

    const { inserted, skipped } = await ctx.repos.articles.upsertMany(articles);

    // ヘッダ未返却時は既知の値を保持する(304判定を継続させるため)。
    const etag = response.headers.get('etag') ?? feed.etag;
    const lastModified = response.headers.get('last-modified') ?? feed.lastModified;
    await ctx.repos.feeds.markFetched(feed.id, ctx.now(), { etag, lastModified });

    return { ...base, status: 'ok', inserted, skipped };
  } catch (err) {
    return {
      ...base,
      status: 'error',
      inserted: 0,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
