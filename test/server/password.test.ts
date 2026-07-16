import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../../src/server/password.ts';
import { generateSessionToken, hashSessionToken } from '../../src/server/session.ts';

test('password: hash → verify の往復が成功する', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.match(hash, /^scrypt\$N=\d+,r=\d+,p=\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
});

test('password: 誤パスワードは false', async () => {
  const hash = await hashPassword('password-a');
  assert.equal(await verifyPassword('password-b', hash), false);
  assert.equal(await verifyPassword('', hash), false);
});

test('password: 同じパスワードでもソルトにより毎回異なるハッシュ', async () => {
  const h1 = await hashPassword('same');
  const h2 = await hashPassword('same');
  assert.notEqual(h1, h2);
  assert.equal(await verifyPassword('same', h1), true);
  assert.equal(await verifyPassword('same', h2), true);
});

test('password: 形式不正・改ざんハッシュは false(fail closed)', async () => {
  assert.equal(await verifyPassword('x', ''), false);
  assert.equal(await verifyPassword('x', 'plaintext'), false);
  assert.equal(await verifyPassword('x', 'scrypt$N=abc,r=8,p=1$AAAA$BBBB'), false);
  // 異常コストパラメータ(DoS 防止の上限)を埋め込まれても計算しない
  assert.equal(await verifyPassword('x', `scrypt$N=${1 << 24},r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAA`), false);
  const valid = await hashPassword('x');
  const tampered = valid.slice(0, -4) + (valid.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.equal(await verifyPassword('x', tampered), false);
});

test('password: DUMMY_PASSWORD_HASH はどんな入力でも false(タイミング等化用)', async () => {
  assert.equal(await verifyPassword('', DUMMY_PASSWORD_HASH), false);
  assert.equal(await verifyPassword('anything', DUMMY_PASSWORD_HASH), false);
});

test('session: トークンは十分な長さ・ハッシュは sha256 hex・毎回ユニーク', () => {
  const a = generateSessionToken();
  const b = generateSessionToken();
  assert.ok(a.token.length >= 40, '256bit を base64url した長さがあること');
  assert.match(a.tokenHash, /^[0-9a-f]{64}$/);
  assert.notEqual(a.token, b.token);
  assert.equal(hashSessionToken(a.token), a.tokenHash);
  assert.notEqual(a.tokenHash, hashSessionToken(b.token));
});
