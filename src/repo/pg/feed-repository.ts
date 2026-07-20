import type { Pool } from 'pg';
import type { Feed, FeedPatch, NewFeed } from '../../domain/types.ts';
import type { FeedRepository } from '../../domain/repositories.ts';
import { DuplicateFeedUrlError, NotFoundError, ValidationError } from '../../domain/errors.ts';
import { isUniqueViolation } from './errors.ts';
import { mapFeedRow, type FeedRow } from './mappers.ts';

const MIN_INTERVAL_MINUTES = 15;

function assertValidInterval(minutes: number): void {
  if (minutes < MIN_INTERVAL_MINUTES) {
    throw new ValidationError(`fetch_interval_minutes must be >= ${MIN_INTERVAL_MINUTES}`);
  }
}

export class PgFeedRepository implements FeedRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async create(input: NewFeed): Promise<Feed> {
    const interval = input.fetchIntervalMinutes ?? 60;
    assertValidInterval(interval);
    try {
      const result = await this.pool.query<FeedRow>(
        `insert into feeds (name, feed_url, site_url, fetch_interval_minutes, translate, fulltext_allowed, enabled, tos_note, category)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning *`,
        [
          input.name,
          input.feedUrl,
          input.siteUrl ?? null,
          interval,
          input.translate ?? true,
          input.fulltextAllowed ?? false,
          input.enabled ?? true,
          input.tosNote ?? null,
          input.category ?? null,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('insert into feeds returned no row');
      return mapFeedRow(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateFeedUrlError(input.feedUrl);
      throw err;
    }
  }

  async getById(id: string): Promise<Feed | null> {
    const result = await this.pool.query<FeedRow>(`select * from feeds where id = $1`, [id]);
    const row = result.rows[0];
    return row ? mapFeedRow(row) : null;
  }

  async getByFeedUrl(feedUrl: string): Promise<Feed | null> {
    const result = await this.pool.query<FeedRow>(`select * from feeds where feed_url = $1`, [feedUrl]);
    const row = result.rows[0];
    return row ? mapFeedRow(row) : null;
  }

  async list(): Promise<Feed[]> {
    const result = await this.pool.query<FeedRow>(`select * from feeds order by created_at asc`);
    return result.rows.map(mapFeedRow);
  }

  async listDue(now: Date): Promise<Feed[]> {
    const result = await this.pool.query<FeedRow>(
      `select * from feeds
       where enabled = true
         and (last_fetched_at is null or last_fetched_at + (fetch_interval_minutes * interval '1 minute') <= $1)
       order by created_at asc`,
      [now],
    );
    return result.rows.map(mapFeedRow);
  }

  async update(id: string, patch: FeedPatch): Promise<Feed> {
    if (patch.fetchIntervalMinutes !== undefined) assertValidInterval(patch.fetchIntervalMinutes);

    const columns: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) {
      columns.push('name');
      values.push(patch.name);
    }
    if (patch.feedUrl !== undefined) {
      columns.push('feed_url');
      values.push(patch.feedUrl);
    }
    if (patch.siteUrl !== undefined) {
      columns.push('site_url');
      values.push(patch.siteUrl);
    }
    if (patch.fetchIntervalMinutes !== undefined) {
      columns.push('fetch_interval_minutes');
      values.push(patch.fetchIntervalMinutes);
    }
    if (patch.translate !== undefined) {
      columns.push('translate');
      values.push(patch.translate);
    }
    if (patch.fulltextAllowed !== undefined) {
      columns.push('fulltext_allowed');
      values.push(patch.fulltextAllowed);
    }
    if (patch.enabled !== undefined) {
      columns.push('enabled');
      values.push(patch.enabled);
    }
    if (patch.tosNote !== undefined) {
      columns.push('tos_note');
      values.push(patch.tosNote);
    }
    if (patch.category !== undefined) {
      columns.push('category');
      values.push(patch.category);
    }
    columns.push('updated_at');
    values.push(new Date());

    const setClause = columns.map((col, i) => `${col} = $${i + 2}`).join(', ');

    try {
      const result = await this.pool.query<FeedRow>(
        `update feeds set ${setClause} where id = $1 returning *`,
        [id, ...values],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundError('feed', id);
      return mapFeedRow(row);
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      if (isUniqueViolation(err)) throw new DuplicateFeedUrlError(String(patch.feedUrl));
      throw err;
    }
  }

  async markFetched(
    id: string,
    fetchedAt: Date,
    meta?: { etag?: string | null; lastModified?: string | null },
  ): Promise<void> {
    const columns: string[] = ['last_fetched_at'];
    const values: unknown[] = [fetchedAt];
    if (meta?.etag !== undefined) {
      columns.push('etag');
      values.push(meta.etag);
    }
    if (meta?.lastModified !== undefined) {
      columns.push('last_modified');
      values.push(meta.lastModified);
    }
    columns.push('updated_at');
    values.push(new Date());

    const setClause = columns.map((col, i) => `${col} = $${i + 2}`).join(', ');
    const result = await this.pool.query(`update feeds set ${setClause} where id = $1`, [id, ...values]);
    if (result.rowCount === 0) throw new NotFoundError('feed', id);
  }

  async delete(id: string): Promise<void> {
    const result = await this.pool.query(`delete from feeds where id = $1`, [id]);
    if (result.rowCount === 0) throw new NotFoundError('feed', id);
  }
}
