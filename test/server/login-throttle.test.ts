import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoginThrottle } from '../../src/server/login-throttle.ts';

/**
 * ログイン総当たり対策(設計書 §7 / docs/004_KnownLimitations.md §7 の実装)。
 * 純粋ロジック + 注入クロックでユニットテストする(TDD の主戦場)。
 */

function fixedClock(startMs = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = startMs;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('throttle: 閾値未満は許可、閾値到達で limited になる', () => {
  const clock = fixedClock();
  const th = new LoginThrottle({ windowMs: 15 * 60_000, maxPerKey: 5, now: clock.now });
  const keys = ['u:admin', 'ip:203.0.113.5'];

  for (let i = 0; i < 4; i++) {
    assert.equal(th.check(keys).limited, false, `attempt ${i} should be allowed`);
    th.recordFailure(keys);
  }
  // 5回目の失敗を記録 → 以降 limited
  assert.equal(th.check(keys).limited, false); // 4件記録済み、まだ閾値未満
  th.recordFailure(keys); // 5件目
  const decision = th.check(keys);
  assert.equal(decision.limited, true);
  assert.ok(decision.retryAfterSec > 0, 'retryAfterSec は正の秒数');
});

test('throttle: いずれかのキーが閾値超過なら limited(ユーザー名 or IP)', () => {
  const clock = fixedClock();
  const th = new LoginThrottle({ windowMs: 15 * 60_000, maxPerKey: 3, now: clock.now });

  // 同一IPから異なるユーザー名を狙うパスワードスプレー: IPキーが先に飽和する
  for (let i = 0; i < 3; i++) {
    th.recordFailure([`u:victim${i}`, 'ip:198.51.100.9']);
  }
  // 新しいユーザー名(u:victim3)自体は0件だが、IPキーが3件で閾値到達 → limited
  assert.equal(th.check(['u:victim3', 'ip:198.51.100.9']).limited, true);
  // 別IPなら通る
  assert.equal(th.check(['u:victim3', 'ip:203.0.113.1']).limited, false);
});

test('throttle: ウィンドウ経過で自然回復する(スライディング)', () => {
  const clock = fixedClock();
  const windowMs = 15 * 60_000;
  const th = new LoginThrottle({ windowMs, maxPerKey: 3, now: clock.now });
  const keys = ['u:admin'];

  for (let i = 0; i < 3; i++) th.recordFailure(keys);
  assert.equal(th.check(keys).limited, true);

  // ウィンドウを1ms超えて経過 → 全失敗が窓外 → 回復
  clock.advance(windowMs + 1);
  assert.equal(th.check(keys).limited, false);
});

test('throttle: reset() は成功ログイン時にキーの失敗履歴を消す', () => {
  const clock = fixedClock();
  const th = new LoginThrottle({ windowMs: 15 * 60_000, maxPerKey: 3, now: clock.now });
  const keys = ['u:admin', 'ip:203.0.113.5'];

  for (let i = 0; i < 3; i++) th.recordFailure(keys);
  assert.equal(th.check(keys).limited, true);

  th.reset(keys);
  assert.equal(th.check(keys).limited, false);
});

test('throttle: retryAfterSec は最古の失敗が窓を抜けるまでの残り時間', () => {
  const clock = fixedClock();
  const windowMs = 15 * 60_000;
  const th = new LoginThrottle({ windowMs, maxPerKey: 1, now: clock.now });
  const keys = ['u:admin'];

  th.recordFailure(keys); // t=1_000_000
  clock.advance(60_000); // 1分経過
  const d = th.check(keys);
  assert.equal(d.limited, true);
  // 残り = window - 60s = 900 - 60 = 840 秒(±1秒の丸め許容)
  assert.ok(Math.abs(d.retryAfterSec - 840) <= 1, `retryAfterSec=${d.retryAfterSec}`);
});

test('throttle: 追跡キー数に上限があり、無制限に増えない(メモリDoS対策)', () => {
  const clock = fixedClock();
  const th = new LoginThrottle({ windowMs: 15 * 60_000, maxPerKey: 5, maxTrackedKeys: 100, now: clock.now });
  // 一意なIPを大量に失敗させても、内部マップは上限で頭打ちになる
  for (let i = 0; i < 5000; i++) {
    th.recordFailure([`ip:10.${(i >> 8) & 255}.${i & 255}.1`]);
    clock.advance(1); // 各失敗を少しずつずらす
  }
  assert.ok(th.size() <= 100, `size=${th.size()} は maxTrackedKeys(100) 以下であるべき`);
});
