import { createHash, randomBytes } from 'node:crypto';

/**
 * ブラウザセッションのトークン管理。
 * Cookie にはトークン原文、DB には sha256 ハッシュのみを置く —
 * DB が漏れてもセッションを偽造できない(設計書 §7 の「トークンを保存しない」方針に合わせる)。
 */

export const SESSION_COOKIE_NAME = 'session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000; // 30日

export function generateSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
