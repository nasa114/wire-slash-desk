/**
 * T4-2: MCP OAuth 2.1(設計書 §7 Phase B)用の oauth_clients / oauth_codes / oauth_tokens。
 * トークン・認可コードは sha256 ハッシュのみ保存(sessions と同方針 — 原文は DB に置かない)。
 * client_info は RFC 7591 のクライアントメタデータ一式(jsonb)。動的登録クライアントの
 * client_secret を含み得る点は受容リスクとして docs/004_KnownLimitations.md に記載。
 */

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
export const shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
export const up = (pgm) => {
  pgm.sql(`
    create table oauth_clients (
      client_id   text primary key,
      client_info jsonb not null,
      created_at  timestamptz not null default now()
    )
  `);

  pgm.sql(`
    create table oauth_codes (
      code_hash      text primary key,
      client_id      text not null references oauth_clients(client_id) on delete cascade,
      user_id        uuid not null references users(id) on delete cascade,
      code_challenge text not null,
      redirect_uri   text not null,
      scopes         text[] not null,
      expires_at     timestamptz not null,
      created_at     timestamptz not null default now()
    )
  `);

  pgm.sql(`
    create table oauth_tokens (
      id                 uuid primary key default gen_random_uuid(),
      client_id          text not null references oauth_clients(client_id) on delete cascade,
      user_id            uuid not null references users(id) on delete cascade,
      scopes             text[] not null,
      access_token_hash  text not null unique,
      access_expires_at  timestamptz not null,
      refresh_token_hash text not null unique,
      refresh_expires_at timestamptz not null,
      created_at         timestamptz not null default now()
    )
  `);

  pgm.sql(`create index oauth_codes_expires_at_idx on oauth_codes (expires_at)`);
  pgm.sql(`create index oauth_tokens_refresh_expires_at_idx on oauth_tokens (refresh_expires_at)`);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
export const down = (pgm) => {
  pgm.sql(`drop index if exists oauth_tokens_refresh_expires_at_idx`);
  pgm.sql(`drop index if exists oauth_codes_expires_at_idx`);
  pgm.sql(`drop table if exists oauth_tokens`);
  pgm.sql(`drop table if exists oauth_codes`);
  pgm.sql(`drop table if exists oauth_clients`);
};
