import type { Article, Feed } from '../../domain/types.ts';

/** feeds/articles が cascade 削除を共有するための共通ストア。 */
export interface MemoryStore {
  feeds: Map<string, Feed>;
  articles: Map<string, Article>;
}

export function createMemoryStore(): MemoryStore {
  return { feeds: new Map(), articles: new Map() };
}
