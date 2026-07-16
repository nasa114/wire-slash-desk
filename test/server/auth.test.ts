import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractBearerToken,
  timingSafeEqualStr,
  verifyBearer,
  verifyCollectorToken,
} from '../../src/server/auth.ts';

test('timingSafeEqualStr: equal strings match, different do not', () => {
  assert.equal(timingSafeEqualStr('secret-token', 'secret-token'), true);
  assert.equal(timingSafeEqualStr('secret-token', 'secret-tokex'), false);
});

test('timingSafeEqualStr: differing lengths do not throw and return false', () => {
  assert.doesNotThrow(() => timingSafeEqualStr('short', 'a-much-longer-value'));
  assert.equal(timingSafeEqualStr('short', 'a-much-longer-value'), false);
  assert.equal(timingSafeEqualStr('', 'x'), false);
  assert.equal(timingSafeEqualStr('', ''), true);
});

test('extractBearerToken parses scheme case-insensitively', () => {
  assert.equal(extractBearerToken('Bearer abc123'), 'abc123');
  assert.equal(extractBearerToken('bearer   abc123'), 'abc123');
  assert.equal(extractBearerToken('Basic abc123'), null);
  assert.equal(extractBearerToken('abc123'), null);
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken('Bearer '), null);
});

test('verifyBearer: correct token passes, wrong/missing fails', () => {
  const expected = 'the-real-bearer';
  assert.equal(verifyBearer('Bearer the-real-bearer', expected), true);
  assert.equal(verifyBearer('Bearer wrong', expected), false);
  assert.equal(verifyBearer(undefined, expected), false);
  assert.equal(verifyBearer('the-real-bearer', expected), false); // no scheme
});

test('verifyBearer: empty expected fails closed', () => {
  assert.equal(verifyBearer('Bearer anything', ''), false);
  assert.equal(verifyBearer('Bearer ', ''), false);
});

test('verifyCollectorToken: correct token passes, wrong/missing fails', () => {
  const expected = 'collector-secret';
  assert.equal(verifyCollectorToken('collector-secret', expected), true);
  assert.equal(verifyCollectorToken(' collector-secret ', expected), true);
  assert.equal(verifyCollectorToken('nope', expected), false);
  assert.equal(verifyCollectorToken(undefined, expected), false);
  assert.equal(verifyCollectorToken('collector-secret', ''), false);
});
