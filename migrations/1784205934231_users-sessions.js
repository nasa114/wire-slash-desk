/**
 * T4-1: 管理UI(ブラウザログイン)用の users / sessions。
 * パスワードは scrypt ハッシュのみ保存(生パスワード・トークンは保存しない)。
 * sessions.token_hash はセッショントークンの sha256 — トークン原文は DB に置かない。
 */

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
export const shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
export const up = (pgm) => {
  pgm.sql(`
    create table users (
      id            uuid primary key default gen_random_uuid(),
      username      text not null unique,
      password_hash text not null,
      created_at    timestamptz not null default now(),
      updated_at    timestamptz not null default now()
    )
  `);

  pgm.sql(`
    create table sessions (
      id         uuid primary key default gen_random_uuid(),
      user_id    uuid not null references users(id) on delete cascade,
      token_hash text not null unique,
      expires_at timestamptz not null,
      created_at timestamptz not null default now()
    )
  `);

  pgm.sql(`create index sessions_expires_at_idx on sessions (expires_at)`);
  pgm.sql(`create index sessions_user_id_idx on sessions (user_id)`);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
export const down = (pgm) => {
  pgm.sql(`drop index if exists sessions_user_id_idx`);
  pgm.sql(`drop index if exists sessions_expires_at_idx`);
  pgm.sql(`drop table if exists sessions`);
  pgm.sql(`drop table if exists users`);
};
