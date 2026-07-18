import type { Pool } from 'pg';
import type {
  NewOAuthClient,
  NewOAuthCode,
  NewOAuthToken,
  OAuthClient,
  OAuthCode,
  OAuthToken,
} from '../../domain/types.ts';
import type {
  OAuthClientRepository,
  OAuthCodeRepository,
  OAuthTokenRepository,
} from '../../domain/repositories.ts';
import { DuplicateOAuthClientError, NotFoundError } from '../../domain/errors.ts';
import { isForeignKeyViolation, isUniqueViolation } from './errors.ts';
import {
  mapOAuthClientRow,
  mapOAuthCodeRow,
  mapOAuthTokenRow,
  type OAuthClientRow,
  type OAuthCodeRow,
  type OAuthTokenRow,
} from './mappers.ts';

export class PgOAuthClientRepository implements OAuthClientRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async create(input: NewOAuthClient): Promise<OAuthClient> {
    try {
      const result = await this.pool.query<OAuthClientRow>(
        `insert into oauth_clients (client_id, client_info) values ($1, $2) returning *`,
        [input.clientId, JSON.stringify(input.clientInfo)],
      );
      const row = result.rows[0];
      if (!row) throw new Error('insert into oauth_clients returned no row');
      return mapOAuthClientRow(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateOAuthClientError(input.clientId);
      throw err;
    }
  }

  async getById(clientId: string): Promise<OAuthClient | null> {
    const result = await this.pool.query<OAuthClientRow>(
      `select * from oauth_clients where client_id = $1`,
      [clientId],
    );
    const row = result.rows[0];
    return row ? mapOAuthClientRow(row) : null;
  }

  async count(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(`select count(*) from oauth_clients`);
    return Number(result.rows[0]?.count ?? 0);
  }
}

export class PgOAuthCodeRepository implements OAuthCodeRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async create(input: NewOAuthCode): Promise<OAuthCode> {
    try {
      const result = await this.pool.query<OAuthCodeRow>(
        `insert into oauth_codes
           (code_hash, client_id, user_id, code_challenge, redirect_uri, scopes, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7) returning *`,
        [
          input.codeHash,
          input.clientId,
          input.userId,
          input.codeChallenge,
          input.redirectUri,
          input.scopes,
          input.expiresAt,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('insert into oauth_codes returned no row');
      return mapOAuthCodeRow(row);
    } catch (err) {
      // FK 違反はどちらの参照かをドライバのメッセージに依存せず特定できないため、
      // client を先に引いて振り分ける。
      if (isForeignKeyViolation(err)) {
        const client = await this.pool.query(
          `select 1 from oauth_clients where client_id = $1`,
          [input.clientId],
        );
        if ((client.rowCount ?? 0) === 0) throw new NotFoundError('oauth client', input.clientId);
        throw new NotFoundError('user', input.userId);
      }
      throw err;
    }
  }

  async getByCodeHash(codeHash: string): Promise<OAuthCode | null> {
    const result = await this.pool.query<OAuthCodeRow>(
      `select * from oauth_codes where code_hash = $1`,
      [codeHash],
    );
    const row = result.rows[0];
    return row ? mapOAuthCodeRow(row) : null;
  }

  async consumeByCodeHash(codeHash: string): Promise<OAuthCode | null> {
    // DELETE ... RETURNING で one-time use を原子的に保証(並行交換の二重成功を防ぐ)。
    const result = await this.pool.query<OAuthCodeRow>(
      `delete from oauth_codes where code_hash = $1 returning *`,
      [codeHash],
    );
    const row = result.rows[0];
    return row ? mapOAuthCodeRow(row) : null;
  }

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.pool.query(`delete from oauth_codes where expires_at <= $1`, [now]);
    return result.rowCount ?? 0;
  }
}

export class PgOAuthTokenRepository implements OAuthTokenRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async create(input: NewOAuthToken): Promise<OAuthToken> {
    try {
      const result = await this.pool.query<OAuthTokenRow>(
        `insert into oauth_tokens
           (client_id, user_id, scopes, access_token_hash, access_expires_at,
            refresh_token_hash, refresh_expires_at)
         values ($1, $2, $3, $4, $5, $6, $7) returning *`,
        [
          input.clientId,
          input.userId,
          input.scopes,
          input.accessTokenHash,
          input.accessExpiresAt,
          input.refreshTokenHash,
          input.refreshExpiresAt,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('insert into oauth_tokens returned no row');
      return mapOAuthTokenRow(row);
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        const client = await this.pool.query(
          `select 1 from oauth_clients where client_id = $1`,
          [input.clientId],
        );
        if ((client.rowCount ?? 0) === 0) throw new NotFoundError('oauth client', input.clientId);
        throw new NotFoundError('user', input.userId);
      }
      throw err;
    }
  }

  async getByAccessTokenHash(hash: string): Promise<OAuthToken | null> {
    const result = await this.pool.query<OAuthTokenRow>(
      `select * from oauth_tokens where access_token_hash = $1`,
      [hash],
    );
    const row = result.rows[0];
    return row ? mapOAuthTokenRow(row) : null;
  }

  async getByRefreshTokenHash(hash: string): Promise<OAuthToken | null> {
    const result = await this.pool.query<OAuthTokenRow>(
      `select * from oauth_tokens where refresh_token_hash = $1`,
      [hash],
    );
    const row = result.rows[0];
    return row ? mapOAuthTokenRow(row) : null;
  }

  async consumeByRefreshTokenHash(hash: string): Promise<OAuthToken | null> {
    // DELETE ... RETURNING でローテーションを原子化(並行リフレッシュの二重発行防止)。
    const result = await this.pool.query<OAuthTokenRow>(
      `delete from oauth_tokens where refresh_token_hash = $1 returning *`,
      [hash],
    );
    const row = result.rows[0];
    return row ? mapOAuthTokenRow(row) : null;
  }

  async deleteById(id: string): Promise<void> {
    await this.pool.query(`delete from oauth_tokens where id = $1`, [id]);
  }

  async deleteByAnyTokenHash(hash: string): Promise<void> {
    await this.pool.query(
      `delete from oauth_tokens where access_token_hash = $1 or refresh_token_hash = $1`,
      [hash],
    );
  }

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.pool.query(`delete from oauth_tokens where refresh_expires_at <= $1`, [
      now,
    ]);
    return result.rowCount ?? 0;
  }
}
