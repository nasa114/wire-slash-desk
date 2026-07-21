/**
 * 為替レートのキャッシュ(設計書 §14、T4-3)。
 * pair ごとに最新スナップショット1行のみ保持し、fetched_at で TTL(既定20分)を判定する。
 * 履歴は持たない(表示用途のみ)。
 */

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
export const shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
export const up = (pgm) => {
  pgm.sql(`
    create table exchange_rates (
      pair        text primary key,
      rate        double precision not null,
      prev_close  double precision,
      market_time timestamptz,
      fetched_at  timestamptz not null
    )
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
export const down = (pgm) => {
  pgm.sql(`drop table if exists exchange_rates`);
};
