import type { Article, Feed, FeedPatch, NewArticle, NewFeed } from './types.ts';

/** リポジトリ実装(memory / pg)を差し替えるための共通インターフェース(設計書 §3, D6)。 */
export interface FeedRepository {
  /** feedUrl 重複は DuplicateFeedUrlError、fetchIntervalMinutes < 15 は ValidationError。 */
  create(input: NewFeed): Promise<Feed>;
  getById(id: string): Promise<Feed | null>;
  getByFeedUrl(feedUrl: string): Promise<Feed | null>;
  list(): Promise<Feed[]>;
  /** enabled かつ (未取得 or lastFetchedAt + interval <= now) のフィード(設計書 §5-1)。 */
  listDue(now: Date): Promise<Feed[]>;
  /** 存在しない id は NotFoundError。 */
  update(id: string, patch: FeedPatch): Promise<Feed>;
  /** 取得完了の記録。304 時は meta 省略で lastFetchedAt のみ更新。 */
  markFetched(
    id: string,
    fetchedAt: Date,
    meta?: { etag?: string | null; lastModified?: string | null },
  ): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ListRecentOptions {
  since?: Date;
  feedId?: string;
  /** 既定 50、上限 200(設計書 §7)。 */
  limit?: number;
}

export interface UpsertResult {
  inserted: number;
  skipped: number;
}

export interface ArticleRepository {
  /** (feedId, guid) 重複は上書きせずスキップ(設計書 §5-4)。未知の feedId は NotFoundError。 */
  upsertMany(items: NewArticle[]): Promise<UpsertResult>;
  getById(id: string): Promise<Article | null>;
  listRecent(options?: ListRecentOptions): Promise<Article[]>;
  searchByTitle(query: string, limit?: number): Promise<Article[]>;
  /** date は 'YYYY-MM-DD'(UTC 日付で publishedAt を照合)。 */
  listByDate(date: string): Promise<Article[]>;
  /** fulltext_allowed ソースの明示操作でのみ呼ぶこと。存在しない id は NotFoundError。 */
  setContent(id: string, content: string): Promise<void>;
}

export interface Repositories {
  feeds: FeedRepository;
  articles: ArticleRepository;
  close(): Promise<void>;
}
