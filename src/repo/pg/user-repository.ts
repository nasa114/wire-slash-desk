import type { Pool } from 'pg';
import type { NewUser, User } from '../../domain/types.ts';
import type { UserRepository } from '../../domain/repositories.ts';
import { DuplicateUsernameError } from '../../domain/errors.ts';
import { isUniqueViolation } from './errors.ts';
import { mapUserRow, type UserRow } from './mappers.ts';

export class PgUserRepository implements UserRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async create(input: NewUser): Promise<User> {
    try {
      const result = await this.pool.query<UserRow>(
        `insert into users (username, password_hash) values ($1, $2) returning *`,
        [input.username, input.passwordHash],
      );
      const row = result.rows[0];
      if (!row) throw new Error('insert into users returned no row');
      return mapUserRow(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateUsernameError(input.username);
      throw err;
    }
  }

  async createInitial(input: NewUser): Promise<User | null> {
    // PT-001: count()→create() の TOCTOU を排除する原子的 first-run 作成。
    // READ COMMITTED では `insert ... where not exists` だけだと並行トランザクション
    // が互いのコミット前スナップショットを見て複数挿入し得るため、トランザクション
    // スコープの advisory lock で first-run 処理を直列化する(ロック解放は COMMIT/
    // ROLLBACK 時に自動)。キーは "初回セットアップ" 用途の固定値。
    const SETUP_LOCK_KEY = 2026071900;
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock($1)', [SETUP_LOCK_KEY]);
      const result = await client.query<UserRow>(
        `insert into users (username, password_hash)
           select $1, $2
           where not exists (select 1 from users)
         returning *`,
        [input.username, input.passwordHash],
      );
      await client.query('commit');
      const row = result.rows[0];
      return row ? mapUserRow(row) : null;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async getById(id: string): Promise<User | null> {
    const result = await this.pool.query<UserRow>(`select * from users where id = $1`, [id]);
    const row = result.rows[0];
    return row ? mapUserRow(row) : null;
  }

  async getByUsername(username: string): Promise<User | null> {
    const result = await this.pool.query<UserRow>(`select * from users where username = $1`, [
      username,
    ]);
    const row = result.rows[0];
    return row ? mapUserRow(row) : null;
  }

  async count(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(`select count(*) as count from users`);
    return Number(result.rows[0]?.count ?? 0);
  }
}
