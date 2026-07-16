import Parser from 'rss-parser';
import type { Feed } from '../domain/types.ts';
import type { Repositories } from '../domain/repositories.ts';
import { mapFeedItemToArticle } from './map.ts';
import { runWithConcurrency } from './pool.ts';

const DEFAULT_USER_AGENT =
  'personal-rss-reader/0.1 (+https://github.com/example/personal-rss-reader)';
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 10_000;
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
  } = options;

  const startedAt = now();
  const dueFeeds = await repos.feeds.listDue(startedAt);

  const ctx: FeedContext = { repos, fetchFn, now, timeoutMs, userAgent };
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

async function collectFeed(feed: Feed, ctx: FeedContext): Promise<FeedCollectResult> {
  const base = { feedId: feed.id, name: feed.name };
  try {
    const headers: Record<string, string> = {
      'User-Agent': ctx.userAgent,
      Accept: ACCEPT_HEADER,
    };
    if (feed.etag) headers['If-None-Match'] = feed.etag;
    if (feed.lastModified) headers['If-Modified-Since'] = feed.lastModified;

    const response = await ctx.fetchFn(feed.feedUrl, {
      headers,
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });

    if (response.status === 304) {
      await ctx.repos.feeds.markFetched(feed.id, ctx.now());
      return { ...base, status: 'not_modified', inserted: 0, skipped: 0 };
    }

    if (!response.ok) {
      throw new Error(`http_${response.status}`);
    }

    const xml = await response.text();
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
