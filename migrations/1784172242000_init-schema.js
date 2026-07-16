/**
 * T1-1: 初期スキーマ(feeds / articles)。
 * 一次情報: docs/002_Spec.md §4。M5(article_embeddings / article_scores / digests)はこの段階では作らない。
 * gen_random_uuid() は PostgreSQL 17 の組み込み関数のため拡張(pgcrypto等)は不要。
 */

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
export const shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
export const up = (pgm) => {
  pgm.sql(`
    create table feeds (
      id                     uuid primary key default gen_random_uuid(),
      name                   text not null,
      feed_url               text not null unique,
      site_url               text,
      fetch_interval_minutes int  not null default 60 check (fetch_interval_minutes >= 15),
      translate              boolean not null default true,
      fulltext_allowed       boolean not null default false,
      enabled                boolean not null default true,
      tos_note               text,
      etag                   text,
      last_modified          text,
      last_fetched_at        timestamptz,
      created_at             timestamptz not null default now(),
      updated_at             timestamptz not null default now()
    )
  `);

  pgm.sql(`
    create table articles (
      id           uuid primary key default gen_random_uuid(),
      feed_id      uuid not null references feeds(id) on delete cascade,
      guid         text not null,
      title        text not null,
      url          text not null,
      published_at timestamptz,
      lang         text,
      content      text,
      fetched_at   timestamptz not null default now(),
      unique (feed_id, guid)
    )
  `);

  pgm.sql(`create index articles_published_at_idx on articles (published_at)`);
  pgm.sql(`create index articles_feed_id_idx on articles (feed_id)`);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
export const down = (pgm) => {
  pgm.sql(`drop index if exists articles_feed_id_idx`);
  pgm.sql(`drop index if exists articles_published_at_idx`);
  pgm.sql(`drop table if exists articles`);
  pgm.sql(`drop table if exists feeds`);
};
