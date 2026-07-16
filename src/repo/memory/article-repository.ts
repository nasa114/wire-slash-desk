import { randomUUID } from 'node:crypto';
import type { Article, NewArticle } from '../../domain/types.ts';
import type {
  ArticleRepository,
  ListRecentOptions,
  SearchOptions,
  UpsertResult,
} from '../../domain/repositories.ts';
import { NotFoundError } from '../../domain/errors.ts';
import { clampLimit } from '../limit.ts';
import { cloneArticle, type MemoryStore } from './store.ts';

/** publishedAt 降順(null は最後)、同値は fetchedAt 降順。 */
function byRecency(a: Article, b: Article): number {
  const ap = a.publishedAt?.getTime() ?? -Infinity;
  const bp = b.publishedAt?.getTime() ?? -Infinity;
  if (ap !== bp) return bp - ap;
  return b.fetchedAt.getTime() - a.fetchedAt.getTime();
}

export class MemoryArticleRepository implements ArticleRepository {
  private readonly store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  async upsertMany(items: NewArticle[]): Promise<UpsertResult> {
    // 事前検証: 未知の feedId が1件でもあれば何も保存せず NotFoundError(pg 実装と同じ原子性)。
    const distinctFeedIds = [...new Set(items.map((item) => item.feedId))];
    for (const feedId of distinctFeedIds) {
      if (!this.store.feeds.has(feedId)) throw new NotFoundError('feed', feedId);
    }

    let inserted = 0;
    let skipped = 0;
    for (const item of items) {
      const exists = [...this.store.articles.values()].some(
        (a) => a.feedId === item.feedId && a.guid === item.guid,
      );
      if (exists) {
        skipped += 1;
        continue;
      }
      const article: Article = {
        id: randomUUID(),
        feedId: item.feedId,
        guid: item.guid,
        title: item.title,
        url: item.url,
        // 呼び出し側の Date インスタンスをそのまま保持しない(後から mutate されても内部状態が壊れないように複製)。
        publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
        lang: item.lang ?? null,
        content: null, // 収集経路では常に null(設計書 §5 不変条件)
        fetchedAt: new Date(),
      };
      this.store.articles.set(article.id, article);
      inserted += 1;
    }
    return { inserted, skipped };
  }

  async getById(id: string): Promise<Article | null> {
    const article = this.store.articles.get(id);
    return article ? cloneArticle(article) : null;
  }

  async listRecent(options: ListRecentOptions = {}): Promise<Article[]> {
    const limit = clampLimit(options.limit);
    return [...this.store.articles.values()]
      .filter((a) => {
        if (options.feedId !== undefined && a.feedId !== options.feedId) return false;
        if (options.since !== undefined) {
          if (a.publishedAt === null) return false;
          if (a.publishedAt.getTime() < options.since.getTime()) return false;
        }
        return true;
      })
      .sort(byRecency)
      .slice(0, limit)
      .map(cloneArticle);
  }

  async searchByTitle(query: string, options: SearchOptions = {}): Promise<Article[]> {
    const q = query.toLowerCase();
    return [...this.store.articles.values()]
      .filter(
        (a) =>
          (options.feedId === undefined || a.feedId === options.feedId) &&
          a.title.toLowerCase().includes(q),
      )
      .sort(byRecency)
      .slice(0, clampLimit(options.limit))
      .map(cloneArticle);
  }

  async listByDate(date: string): Promise<Article[]> {
    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60_000);
    return [...this.store.articles.values()]
      .filter(
        (a) =>
          a.publishedAt !== null &&
          a.publishedAt.getTime() >= start.getTime() &&
          a.publishedAt.getTime() < end.getTime(),
      )
      .sort(byRecency)
      .map(cloneArticle);
  }

  async setContent(id: string, content: string): Promise<void> {
    const article = this.store.articles.get(id);
    if (!article) throw new NotFoundError('article', id);
    this.store.articles.set(id, { ...article, content });
  }
}
