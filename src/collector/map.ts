import { createHash } from 'node:crypto';
import type Parser from 'rss-parser';
import type { NewArticle } from '../domain/types.ts';

/**
 * rss-parser の Item を NewArticle にマッピングする層。
 *
 * 不変条件(設計書 §5): item.content / item['content:encoded'] / item.summary など
 * 本文系フィールドには一切触れない。NewArticle 型自体に content フィールドが無いため、
 * ここで拾わない限り本文が保存経路に乗ることはない。
 */
export function mapFeedItemToArticle(
  feedId: string,
  item: Parser.Item,
  feedLang: string | null,
): NewArticle | null {
  const url = item.link;
  if (!url) return null; // url の無いアイテムはスキップ(設計書 §5)

  const title = item.title && item.title.trim().length > 0 ? item.title : url;
  const guid = item.guid && item.guid.trim().length > 0 ? item.guid : sha256Hex(url);
  const publishedAt = parsePublishedAt(item.isoDate ?? item.pubDate);

  return {
    feedId,
    guid,
    title,
    url,
    publishedAt,
    lang: feedLang,
  };
}

function parsePublishedAt(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
