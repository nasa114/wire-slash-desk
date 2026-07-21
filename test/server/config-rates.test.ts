import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../../src/config.ts';

/**
 * 為替レートウィジェットの設定(T4-3、設計書 §14)。
 * EXCHANGE_RATE_PAIRS / EXCHANGE_RATE_TTL_MINUTES の解釈を検証する。
 * 流儀は test/server/config.test.ts に合わせる(loadConfig に素の env オブジェクトを渡す)。
 */

// --- EXCHANGE_RATE_PAIRS ----------------------------------------------------

test('loadConfig: EXCHANGE_RATE_PAIRS 未設定なら既定 [USDJPY, EURJPY]', () => {
  assert.deepEqual(loadConfig({}).exchangeRatePairs, ['USDJPY', 'EURJPY']);
});

test('loadConfig: EXCHANGE_RATE_PAIRS 空文字・空白のみは未設定扱い(既定値)', () => {
  // 既存 config の慣習(空文字・空白のみの値は未設定扱い)に合わせる。
  assert.deepEqual(loadConfig({ EXCHANGE_RATE_PAIRS: '' }).exchangeRatePairs, ['USDJPY', 'EURJPY']);
  assert.deepEqual(loadConfig({ EXCHANGE_RATE_PAIRS: '   ' }).exchangeRatePairs, ['USDJPY', 'EURJPY']);
});

test('loadConfig: EXCHANGE_RATE_PAIRS "off" は大文字小文字不問で無効化([])', () => {
  assert.deepEqual(loadConfig({ EXCHANGE_RATE_PAIRS: 'off' }).exchangeRatePairs, []);
  assert.deepEqual(loadConfig({ EXCHANGE_RATE_PAIRS: 'OFF' }).exchangeRatePairs, []);
  assert.deepEqual(loadConfig({ EXCHANGE_RATE_PAIRS: 'Off' }).exchangeRatePairs, []);
});

test('loadConfig: EXCHANGE_RATE_PAIRS はカンマ区切りを trim + 大文字化して解釈', () => {
  assert.deepEqual(
    loadConfig({ EXCHANGE_RATE_PAIRS: 'usdjpy, eurusd' }).exchangeRatePairs,
    ['USDJPY', 'EURUSD'],
  );
  assert.deepEqual(
    loadConfig({ EXCHANGE_RATE_PAIRS: 'USDJPY,EURJPY,GBPJPY' }).exchangeRatePairs,
    ['USDJPY', 'EURJPY', 'GBPJPY'],
  );
});

test('loadConfig: EXCHANGE_RATE_PAIRS に 6文字[A-Z] でない要素があれば ConfigError', () => {
  assert.throws(() => loadConfig({ EXCHANGE_RATE_PAIRS: 'ABC' }), ConfigError);
  assert.throws(() => loadConfig({ EXCHANGE_RATE_PAIRS: 'USDJPY,ABC' }), ConfigError, '正しい要素が混ざっていても不正要素で拒否');
  assert.throws(() => loadConfig({ EXCHANGE_RATE_PAIRS: 'USD/JPY' }), ConfigError);
  assert.throws(() => loadConfig({ EXCHANGE_RATE_PAIRS: 'USDJPY=X' }), ConfigError);
  assert.throws(() => loadConfig({ EXCHANGE_RATE_PAIRS: 'USDJPY1' }), ConfigError);
});

// --- EXCHANGE_RATE_TTL_MINUTES ----------------------------------------------

test('loadConfig: EXCHANGE_RATE_TTL_MINUTES 未設定なら既定 20', () => {
  assert.equal(loadConfig({}).exchangeRateTtlMinutes, 20);
});

test('loadConfig: EXCHANGE_RATE_TTL_MINUTES は有効な範囲の整数を受け付ける', () => {
  assert.equal(loadConfig({ EXCHANGE_RATE_TTL_MINUTES: '60' }).exchangeRateTtlMinutes, 60);
  assert.equal(loadConfig({ EXCHANGE_RATE_TTL_MINUTES: '1' }).exchangeRateTtlMinutes, 1, '下限 1 は許可');
  assert.equal(loadConfig({ EXCHANGE_RATE_TTL_MINUTES: '1440' }).exchangeRateTtlMinutes, 1440, '上限 1440 は許可');
});

test('loadConfig: EXCHANGE_RATE_TTL_MINUTES の不正値は ConfigError', () => {
  assert.throws(() => loadConfig({ EXCHANGE_RATE_TTL_MINUTES: '0' }), ConfigError, '0 は不可');
  assert.throws(() => loadConfig({ EXCHANGE_RATE_TTL_MINUTES: '1441' }), ConfigError, '1441(>1日)は不可');
  assert.throws(() => loadConfig({ EXCHANGE_RATE_TTL_MINUTES: 'abc' }), ConfigError, '数値でない値は不可');
  assert.throws(() => loadConfig({ EXCHANGE_RATE_TTL_MINUTES: '-5' }), ConfigError, '負数は不可');
});
