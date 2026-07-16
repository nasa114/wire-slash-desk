import type { Article, Feed } from '../../domain/types.ts';

/** feeds テーブルの行(snake_case)。pg ドライバは timestamptz/uuid/int/bool を適切な JS 型へ変換済み。 */
export interface FeedRow {
  id: string;
  name: string;
  feed_url: string;
  site_url: string | null;
  fetch_interval_minutes: number;
  translate: boolean;
  fulltext_allowed: boolean;
  enabled: boolean;
  tos_note: string | null;
  etag: string | null;
  last_modified: string | null;
  last_fetched_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function mapFeedRow(row: FeedRow): Feed {
  return {
    id: row.id,
    name: row.name,
    feedUrl: row.feed_url,
    siteUrl: row.site_url,
    fetchIntervalMinutes: row.fetch_interval_minutes,
    translate: row.translate,
    fulltextAllowed: row.fulltext_allowed,
    enabled: row.enabled,
    tosNote: row.tos_note,
    etag: row.etag,
    lastModified: row.last_modified,
    lastFetchedAt: row.last_fetched_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** articles テーブルの行(snake_case)。 */
export interface ArticleRow {
  id: string;
  feed_id: string;
  guid: string;
  title: string;
  url: string;
  published_at: Date | null;
  lang: string | null;
  content: string | null;
  fetched_at: Date;
}

export function mapArticleRow(row: ArticleRow): Article {
  return {
    id: row.id,
    feedId: row.feed_id,
    guid: row.guid,
    title: row.title,
    url: row.url,
    publishedAt: row.published_at,
    lang: row.lang,
    content: row.content,
    fetchedAt: row.fetched_at,
  };
}
