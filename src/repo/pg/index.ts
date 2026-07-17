import type { Repositories } from '../../domain/repositories.ts';
import { createPgPool } from './pool.ts';
import { PgFeedRepository } from './feed-repository.ts';
import { PgArticleRepository } from './article-repository.ts';
import { PgUserRepository } from './user-repository.ts';
import { PgSessionRepository } from './session-repository.ts';

/** PostgreSQL 実装(T1-2)。close() は内部の Pool を終了する。 */
export function createPgRepositories(connectionString: string): Repositories {
  const pool = createPgPool(connectionString);
  return {
    feeds: new PgFeedRepository(pool),
    articles: new PgArticleRepository(pool),
    users: new PgUserRepository(pool),
    sessions: new PgSessionRepository(pool),
    close: async () => {
      await pool.end();
    },
  };
}
