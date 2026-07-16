import type { Pool } from 'pg';
import type { NewSession, Session } from '../../domain/types.ts';
import type { SessionRepository } from '../../domain/repositories.ts';
import { NotFoundError } from '../../domain/errors.ts';
import { isForeignKeyViolation } from './errors.ts';
import { mapSessionRow, type SessionRow } from './mappers.ts';

export class PgSessionRepository implements SessionRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async create(input: NewSession): Promise<Session> {
    try {
      const result = await this.pool.query<SessionRow>(
        `insert into sessions (user_id, token_hash, expires_at) values ($1, $2, $3) returning *`,
        [input.userId, input.tokenHash, input.expiresAt],
      );
      const row = result.rows[0];
      if (!row) throw new Error('insert into sessions returned no row');
      return mapSessionRow(row);
    } catch (err) {
      if (isForeignKeyViolation(err)) throw new NotFoundError('user', input.userId);
      throw err;
    }
  }

  async getByTokenHash(tokenHash: string): Promise<Session | null> {
    const result = await this.pool.query<SessionRow>(
      `select * from sessions where token_hash = $1`,
      [tokenHash],
    );
    const row = result.rows[0];
    return row ? mapSessionRow(row) : null;
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    await this.pool.query(`delete from sessions where token_hash = $1`, [tokenHash]);
  }

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.pool.query(`delete from sessions where expires_at <= $1`, [now]);
    return result.rowCount ?? 0;
  }
}
