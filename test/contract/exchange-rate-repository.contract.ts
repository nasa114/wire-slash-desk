import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Repositories } from '../../src/domain/repositories.ts';
import type { ExchangeRate } from '../../src/domain/types.ts';

export type MakeRepos = () => Promise<Repositories>;

/** 契約テスト用のサンプルレート。上書き分は Partial で差し替える。 */
function sampleRate(overrides: Partial<ExchangeRate> = {}): ExchangeRate {
  return {
    pair: 'USDJPY',
    rate: 147.606,
    prevClose: 147.211,
    marketTime: new Date('2026-07-21T06:00:00Z'),
    fetchedAt: new Date('2026-07-21T09:00:00Z'),
    ...overrides,
  };
}

/**
 * ExchangeRateRepository 契約テスト(T4-3、設計書 §14)。
 * memory / pg どちらの実装もこのスイートを通過すること。
 */
export function runExchangeRateRepositoryContract(impl: string, makeRepos: MakeRepos): void {
  const t = (name: string) => `[${impl}] ExchangeRateRepository: ${name}`;

  test(t('get: 未登録ペアは null'), async () => {
    const repos = await makeRepos();
    try {
      assert.equal(await repos.exchangeRates.get('USDJPY'), null);
    } finally {
      await repos.close();
    }
  });

  test(t('upsert: 新規登録した全列が get で取得できる'), async () => {
    const repos = await makeRepos();
    try {
      await repos.exchangeRates.upsert(sampleRate());
      const got = await repos.exchangeRates.get('USDJPY');
      assert.ok(got, '登録済みペアは取得できる');
      assert.equal(got.pair, 'USDJPY');
      assert.equal(got.rate, 147.606);
      assert.equal(got.prevClose, 147.211);
      assert.equal(got.marketTime?.getTime(), new Date('2026-07-21T06:00:00Z').getTime());
      assert.equal(got.fetchedAt.getTime(), new Date('2026-07-21T09:00:00Z').getTime());
    } finally {
      await repos.close();
    }
  });

  test(t('upsert: prevClose / marketTime は null を保存できる'), async () => {
    const repos = await makeRepos();
    try {
      await repos.exchangeRates.upsert(sampleRate({ prevClose: null, marketTime: null }));
      const got = await repos.exchangeRates.get('USDJPY');
      assert.ok(got);
      assert.equal(got.prevClose, null);
      assert.equal(got.marketTime, null);
      assert.equal(got.rate, 147.606, 'null 以外の列は保存される');
    } finally {
      await repos.close();
    }
  });

  test(t('upsert: 同一 pair は insert ではなく全列更新(null への上書き含む)'), async () => {
    const repos = await makeRepos();
    try {
      await repos.exchangeRates.upsert(sampleRate());
      await repos.exchangeRates.upsert(
        sampleRate({
          rate: 148.5,
          prevClose: null,
          marketTime: null,
          fetchedAt: new Date('2026-07-21T10:00:00Z'),
        }),
      );
      const got = await repos.exchangeRates.get('USDJPY');
      assert.ok(got);
      assert.equal(got.rate, 148.5, 'rate が更新される');
      assert.equal(got.prevClose, null, '値 → null の上書きも反映される');
      assert.equal(got.marketTime, null, '値 → null の上書きも反映される');
      assert.equal(got.fetchedAt.getTime(), new Date('2026-07-21T10:00:00Z').getTime());

      // 逆方向(null → 値)の上書きも全列反映されること
      await repos.exchangeRates.upsert(sampleRate({ rate: 149.0 }));
      const again = await repos.exchangeRates.get('USDJPY');
      assert.equal(again?.rate, 149.0);
      assert.equal(again?.prevClose, 147.211);
      assert.equal(again?.marketTime?.getTime(), new Date('2026-07-21T06:00:00Z').getTime());
    } finally {
      await repos.close();
    }
  });

  test(t('別ペアは独立に保存され、片方の upsert が他方へ影響しない'), async () => {
    const repos = await makeRepos();
    try {
      await repos.exchangeRates.upsert(sampleRate({ pair: 'USDJPY', rate: 147.606 }));
      await repos.exchangeRates.upsert(sampleRate({ pair: 'EURJPY', rate: 171.42 }));

      assert.equal((await repos.exchangeRates.get('USDJPY'))?.rate, 147.606);
      assert.equal((await repos.exchangeRates.get('EURJPY'))?.rate, 171.42);

      // USDJPY だけ更新 → EURJPY は不変
      await repos.exchangeRates.upsert(sampleRate({ pair: 'USDJPY', rate: 150.0 }));
      assert.equal((await repos.exchangeRates.get('USDJPY'))?.rate, 150.0);
      assert.equal((await repos.exchangeRates.get('EURJPY'))?.rate, 171.42, '他ペアは影響を受けない');
    } finally {
      await repos.close();
    }
  });

  test(t('Date 参照隔離: 入力 Date / 返却値の Date を mutate しても内部状態は不変'), async () => {
    const repos = await makeRepos();
    try {
      const input = sampleRate();
      await repos.exchangeRates.upsert(input);

      // upsert に渡した Date を後から mutate → 保存値は不変であること
      input.marketTime?.setFullYear(1999);
      input.fetchedAt.setFullYear(1999);
      const afterInputMutation = await repos.exchangeRates.get('USDJPY');
      assert.equal(afterInputMutation?.marketTime?.getUTCFullYear(), 2026);
      assert.equal(afterInputMutation?.fetchedAt.getUTCFullYear(), 2026);

      // get で得た Date を mutate → 再取得した値は不変であること
      afterInputMutation?.marketTime?.setFullYear(1900);
      afterInputMutation?.fetchedAt.setFullYear(1900);
      const again = await repos.exchangeRates.get('USDJPY');
      assert.equal(again?.marketTime?.getUTCFullYear(), 2026);
      assert.equal(again?.fetchedAt.getUTCFullYear(), 2026);
    } finally {
      await repos.close();
    }
  });
}
