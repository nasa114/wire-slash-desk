import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * パスワードハッシュ(scrypt / node:crypto のみ・外部依存なし)。
 *
 * 保存形式: `scrypt$N=<N>,r=<r>,p=<p>$<salt(base64url)>$<key(base64url)>`
 * パラメータを形式に埋め込むことで、将来コストを上げても既存ハッシュを検証できる。
 */

const SCRYPT_N = 1 << 15; // 2^15 = 32768。対話ログインで ~100ms 程度のコスト。
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
// maxmem 既定値(32MiB)は 128*N*r = 33,554,432 とほぼ同じで足りないため明示する。
const MAX_MEM = 128 * SCRYPT_N * SCRYPT_R * 2;

const FORMAT_RE = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLen: number,
  opts: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLen, { ...opts, maxmem: MAX_MEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scryptAsync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/**
 * 保存済みハッシュとパスワードを照合する。形式不正・パラメータ異常は false(fail closed)。
 * 比較は timingSafeEqual で行い、途中の例外も false に落とす(内部情報を漏らさない)。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = FORMAT_RE.exec(stored);
  if (match === null) return false;
  const N = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  // DoS 防止: 保存値が壊れて異常コストが埋まっていても計算しない上限。
  if (!Number.isInteger(N) || N < 2 || N > 1 << 20) return false;
  if (!Number.isInteger(r) || r < 1 || r > 32) return false;
  if (!Number.isInteger(p) || p < 1 || p > 16) return false;
  const salt = Buffer.from(match[4] as string, 'base64url');
  const expected = Buffer.from(match[5] as string, 'base64url');
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = await scryptAsync(password, salt, expected.length, { N, r, p });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * 「ユーザーが存在しない」場合でも同等の計算時間をかけるためのダミーハッシュ。
 * ログイン失敗の応答時間からユーザー名の存在有無を推測されるのを防ぐ。
 */
export const DUMMY_PASSWORD_HASH = `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${Buffer.alloc(SALT_LEN).toString('base64url')}$${Buffer.alloc(KEY_LEN).toString('base64url')}`;
