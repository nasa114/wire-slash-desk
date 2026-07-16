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
  const guid = resolveGuid(item, url);
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

/**
 * guid の採用順: item.guid → item.id (Atom の <id>) → sha256(url)。
 *
 * rss-parser 3.13.0 は Atom フィードの <entry><id> を item.guid ではなく
 * item.id に格納する(RSS 2.0 の <guid> のみが item.guid に入る)。
 * Parser.Item の型定義には id が宣言されていないため、'id' in item による
 * 型ガードと typeof チェックで安全に取り出す。
 */
function resolveGuid(item: Parser.Item, url: string): string {
  if (item.guid && item.guid.trim().length > 0) return item.guid;

  const atomId = extractAtomId(item);
  if (atomId && atomId.trim().length > 0) return atomId;

  return sha256Hex(url);
}

function extractAtomId(item: Parser.Item): string | undefined {
  if ('id' in item) {
    const candidate = (item as { id?: unknown }).id;
    if (typeof candidate === 'string') return candidate;
  }
  return undefined;
}

function parsePublishedAt(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
