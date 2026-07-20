/**
 * フィードごとのカテゴリ(配信元の分類)。未分類は null。
 * 長さ上限(100文字)は Web 層のバリデーションで担保する。
 */

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
export const shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
export const up = (pgm) => {
  pgm.sql(`alter table feeds add column category text`);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
export const down = (pgm) => {
  pgm.sql(`alter table feeds drop column if exists category`);
};
