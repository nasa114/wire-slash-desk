/**
 * listRecent / searchByTitle の limit を安全な範囲に正規化する共通ヘルパー。
 * memory / pg 実装の双方から利用し、意味論を一致させる(設計書 §7)。
 */

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/**
 * - 未指定 or NaN は既定 50。
 * - 小数は切り捨て(floor)。
 * - 1 未満は 1。
 * - 200 超は 200(Infinity もここで 200 に収まる)。
 */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return DEFAULT_LIMIT;
  const floored = Number.isFinite(limit) ? Math.floor(limit) : limit;
  return Math.max(1, Math.min(floored, MAX_LIMIT));
}
