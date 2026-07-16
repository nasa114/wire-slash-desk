import type { Pool } from 'pg';
import type { Article, NewArticle } from '../../domain/types.ts';
import type {
  ArticleRepository,
  ListRecentOptions,
  SearchOptions,
  UpsertResult,
} from '../../domain/repositories.ts';
import { NotFoundError } from '../../domain/errors.ts';
import { isForeignKeyViolation } from './errors.ts';
import { mapArticleRow, type ArticleRow } from './mappers.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(limit, MAX_LIMIT));
}

/** ILIKE パターン中の特殊文字(\\ % _)をエスケープする。デフォルトのエスケープ文字は '\\'。 */
function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export class PgArticleRepository implements ArticleRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async upsertMany(items: NewArticle[]): Promise<UpsertResult> {
    if (items.length === 0) return { inserted: 0, skipped: 0 };

    // 事前検証: 未知の feedId は NotFoundError(バルクINSERTのFK違反エラーから
    // 対象idを安全に復元するのが難しいため、事前に存在確認する)。
    const distinctFeedIds = [...new Set(items.map((item) => item.feedId))];
    const existing = await this.pool.query<{ id: string }>(
      `select id from feeds where id = any($1::uuid[])`,
      [distinctFeedIds],
    );
    const existingIds = new Set(existing.rows.map((row) => row.id));
    for (const feedId of distinctFeedIds) {
      if (!existingIds.has(feedId)) throw new NotFoundError('feed', feedId);
    }

    const feedIds = items.map((item) => item.feedId);
    const guids = items.map((item) => item.guid);
    const titles = items.map((item) => item.title);
    const urls = items.map((item) => item.url);
    const publishedAts = items.map((item) => item.publishedAt ?? null);
    const langs = items.map((item) => item.lang ?? null);

    try {
      // content は常に NULL で挿入する(設計書 §5 不変条件)。
      const result = await this.pool.query(
        `insert into articles (feed_id, guid, title, url, published_at, lang, content)
         select feed_id, guid, title, url, published_at, lang, null
         from unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::text[])
           as t(feed_id, guid, title, url, published_at, lang)
         on conflict (feed_id, guid) do nothing
         returning id`,
        [feedIds, guids, titles, urls, publishedAts, langs],
      );
      const inserted = result.rowCount ?? 0;
      return { inserted, skipped: items.length - inserted };
    } catch (err) {
      if (isForeignKeyViolation(err)) throw new NotFoundError('feed', String(feedIds[0]));
      throw err;
    }
  }

  async getById(id: string): Promise<Article | null> {
    const result = await this.pool.query<ArticleRow>(`select * from articles where id = $1`, [id]);
    const row = result.rows[0];
    return row ? mapArticleRow(row) : null;
  }

  async listRecent(options: ListRecentOptions = {}): Promise<Article[]> {
    const limit = clampLimit(options.limit);
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (options.feedId !== undefined) {
      values.push(options.feedId);
      conditions.push(`feed_id = $${values.length}`);
    }
    if (options.since !== undefined) {
      // published_at が null の行は `NULL >= $n` が NULL(偽)評価となり自然に除外される。
      values.push(options.since);
      conditions.push(`published_at >= $${values.length}`);
    }
    const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';
    values.push(limit);

    const result = await this.pool.query<ArticleRow>(
      `select * from articles
       ${where}
       order by published_at desc nulls last, fetched_at desc
       limit $${values.length}`,
      values,
    );
    return result.rows.map(mapArticleRow);
  }

  async searchByTitle(query: string, options: SearchOptions = {}): Promise<Article[]> {
    const pattern = `%${escapeLikePattern(query)}%`;
    const values: unknown[] = [pattern];
    let feedCondition = '';
    if (options.feedId !== undefined) {
      values.push(options.feedId);
      feedCondition = `and feed_id = $${values.length}`;
    }
    values.push(clampLimit(options.limit));
    const result = await this.pool.query<ArticleRow>(
      `select * from articles
       where title ilike $1 ${feedCondition}
       order by published_at desc nulls last, fetched_at desc
       limit $${values.length}`,
      values,
    );
    return result.rows.map(mapArticleRow);
  }

  async listByDate(date: string): Promise<Article[]> {
    // JS 側で UTC 日付境界を明示的に計算し、DBセッションのタイムゾーン設定に依存しないようにする。
    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60_000);
    const result = await this.pool.query<ArticleRow>(
      `select * from articles
       where published_at >= $1 and published_at < $2
       order by published_at desc nulls last, fetched_at desc`,
      [start, end],
    );
    return result.rows.map(mapArticleRow);
  }

  async setContent(id: string, content: string): Promise<void> {
    const result = await this.pool.query(`update articles set content = $2 where id = $1`, [id, content]);
    if (result.rowCount === 0) throw new NotFoundError('article', id);
  }
}
