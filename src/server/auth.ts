import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * タイミングセーフな文字列比較(設計書 §7 認証)。
 *
 * 生の値は長さが異なると timingSafeEqual が例外を投げ、長さ差自体が
 * サイドチャネルになる。そこで両者を sha256 で固定長ダイジェスト化してから
 * 比較することで、長さも内容も漏らさない。
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ad = createHash('sha256').update(a, 'utf8').digest();
  const bd = createHash('sha256').update(b, 'utf8').digest();
  // ダイジェストは常に 32 バイトなので長さは一致する。
  return timingSafeEqual(ad, bd);
}

/** `Authorization: Bearer <token>` からトークン部分を抽出。scheme は大小無視。 */
export function extractBearerToken(headerValue: string | undefined): string | null {
  if (headerValue === undefined) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(headerValue.trim());
  if (match === null) return null;
  const token = match[1]?.trim();
  return token && token.length > 0 ? token : null;
}

/**
 * Bearer トークンを検証。expected が空なら常に false(fail closed)。
 * トークンそのものはログにもエラーにも一切載せない。
 */
export function verifyBearer(headerValue: string | undefined, expected: string): boolean {
  if (expected.length === 0) return false;
  const token = extractBearerToken(headerValue);
  if (token === null) return false;
  return timingSafeEqualStr(token, expected);
}

/** `X-Collector-Token` ヘッダを検証。expected が空なら常に false。 */
export function verifyCollectorToken(headerValue: string | undefined, expected: string): boolean {
  if (expected.length === 0) return false;
  if (headerValue === undefined) return false;
  const provided = headerValue.trim();
  if (provided.length === 0) return false;
  return timingSafeEqualStr(provided, expected);
}
