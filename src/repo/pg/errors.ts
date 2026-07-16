/** pg が投げるエラーから PostgreSQL のエラーコードを取り出すためのヘルパー。 */

interface PgDriverError extends Error {
  code?: string;
}

function isPgDriverError(err: unknown): err is PgDriverError {
  return err instanceof Error && 'code' in err && typeof (err as PgDriverError).code === 'string';
}

/** 23505: unique_violation */
export function isUniqueViolation(err: unknown): boolean {
  return isPgDriverError(err) && err.code === '23505';
}

/** 23503: foreign_key_violation */
export function isForeignKeyViolation(err: unknown): boolean {
  return isPgDriverError(err) && err.code === '23503';
}
