import { randomUUID } from 'node:crypto';
import type { Article, NewArticle } from '../../domain/types.ts';
import type {
  ArticleRepository,
  ListRecentOptions,
  UpsertResult,
} from '../../domain/repositories.ts';
import { NotFoundError } from '../../domain/errors.ts';
import type { MemoryStore } from './store.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(limit, MAX_LIMIT));
}

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
    let inserted = 0;
    let skipped = 0;
    for (const item of items) {
      if (!this.store.feeds.has(item.feedId)) throw new NotFoundError('feed', item.feedId);
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
        publishedAt: item.publishedAt ?? null,
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
    return article ? { ...article } : null;
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
      .map((a) => ({ ...a }));
  }

  async searchByTitle(query: string, limit?: number): Promise<Article[]> {
    const q = query.toLowerCase();
    return [...this.store.articles.values()]
      .filter((a) => a.title.toLowerCase().includes(q))
      .sort(byRecency)
      .slice(0, clampLimit(limit))
      .map((a) => ({ ...a }));
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
      .map((a) => ({ ...a }));
  }

  async setContent(id: string, content: string): Promise<void> {
    const article = this.store.articles.get(id);
    if (!article) throw new NotFoundError('article', id);
    this.store.articles.set(id, { ...article, content });
  }
}
