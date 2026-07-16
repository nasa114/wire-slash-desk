import { Pool } from 'pg';
import type { Repositories } from '../../domain/repositories.ts';
import { PgFeedRepository } from './feed-repository.ts';
import { PgArticleRepository } from './article-repository.ts';

/** PostgreSQL 実装(T1-2)。close() は内部の Pool を終了する。 */
export function createPgRepositories(connectionString: string): Repositories {
  const pool = new Pool({ connectionString });
  return {
    feeds: new PgFeedRepository(pool),
    articles: new PgArticleRepository(pool),
    close: async () => {
      await pool.end();
    },
  };
}
