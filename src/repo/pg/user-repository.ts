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
