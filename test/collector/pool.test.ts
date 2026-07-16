import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithConcurrency } from '../../src/collector/pool.ts';

const INVALID_CONCURRENCIES = [NaN, 0.5, Infinity, 0, -3];

for (const concurrency of INVALID_CONCURRENCIES) {
  test(`runWithConcurrency: concurrency=${concurrency} でも全アイテムが漏れなく処理される`, async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await runWithConcurrency(items, concurrency, async (item) => item * 2);

    assert.equal(results.length, items.length);
    assert.deepEqual(results, [2, 4, 6, 8, 10]);
    assert.ok(
      results.every((r) => r !== undefined),
      'undefined が混じっていないこと',
    );
  });
}

test('runWithConcurrency: 正常な concurrency は従来どおり動作する(回帰)', async () => {
  const items = [1, 2, 3];
  const results = await runWithConcurrency(items, 2, async (item) => item + 1);
  assert.deepEqual(results, [2, 3, 4]);
});
