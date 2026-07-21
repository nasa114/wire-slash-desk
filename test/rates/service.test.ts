import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExchangeRate } from '../../src/domain/types.ts';
import type { ExchangeRateRepository } from '../../src/domain/repositories.ts';
import { createRateService, type RateServiceOptions } from '../../src/rates/service.ts';

/**
 * 為替レートサービス(lazy TTL キャッシュ)のテスト(T4-3、設計書 §14)。
 * repo はインメモリ fake、時刻は決定的クロック、fetchRate は呼び出し記録つき fake。
 * 外部ネットワークには一切触れない。
 */

const MIN = 60_000;
const T0 = new Date('2026-07-21T09:00:00Z');

/** 決定的クロック。clock.current を書き換えて時間を進める。 */
function createClock(start: Date): { current: Date; now: () => Date } {
  const clock = {
    current: new Date(start.getTime()),
    now: () => new Date(clock.current.getTime()),
  };
  return clock;
}

/** インメモリ fake リポジトリ(upsert 呼び出しを記録する)。 */
function createFakeRepo(): ExchangeRateRepository & { upsertCalls: ExchangeRate[] } {
  const store = new Map<string, ExchangeRate>();
  const upsertCalls: ExchangeRate[] = [];
  const copy = (r: ExchangeRate): ExchangeRate => ({
    ...r,
    marketTime: r.marketTime === null ? null : new Date(r.marketTime.getTime()),
    fetchedAt: new Date(r.fetchedAt.getTime()),
  });
  return {
    upsertCalls,
    async get(pair) {
      const found = store.get(pair);
      return found === undefined ? null : copy(found);
    },
    async upsert(input) {
      upsertCalls.push(copy(input));
      store.set(input.pair, copy(input));
    },
  };
}

function makeRate(pair: string, rate: number, fetchedAt: Date): ExchangeRate {
  return {
    pair,
    rate,
    prevClose: rate - 0.5,
    marketTime: new Date('2026-07-21T06:00:00Z'),
    fetchedAt: new Date(fetchedAt.getTime()),
  };
}

/** 呼び出し記録つき fetchRate。pair ごとに成功値 or 失敗を設定できる。 */
function createFakeFetchRate(
  behavior: Record<string, number | Error>,
): RateServiceOptions['fetchRate'] & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (pair: string, now: Date) => {
    calls.push(pair);
    const b = behavior[pair];
    if (b === undefined) throw new Error(`unexpected pair: ${pair}`);
    if (b instanceof Error) throw b;
    return makeRate(pair, b, now);
  }) as RateServiceOptions['fetchRate'] & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/* ----------------------------------------------------------- 基本ケース */

test('rateService: pairs が空配列なら常に [] で fetchRate は呼ばれない', async () => {
  const clock = createClock(T0);
  const fetchRate = createFakeFetchRate({});
  const service = createRateService({
    repo: createFakeRepo(),
    pairs: [],
    ttlMinutes: 20,
    fetchRate,
    now: clock.now,
  });
  assert.deepEqual(await service.getRates(), []);
  assert.deepEqual(await service.getRates(), []);
  assert.equal(fetchRate.calls.length, 0);
});

test('rateService: キャッシュ無しなら fetchRate を1回呼び、upsert して stale:false で返す', async () => {
  const clock = createClock(T0);
  const repo = createFakeRepo();
  const fetchRate = createFakeFetchRate({ USDJPY: 147.606 });
  const service = createRateService({ repo, pairs: ['USDJPY'], ttlMinutes: 20, fetchRate, now: clock.now });

  const rates = await service.getRates();
  assert.equal(fetchRate.calls.length, 1);
  assert.equal(rates.length, 1);
  const view = rates[0]!;
  assert.equal(view.pair, 'USDJPY');
  assert.equal(view.rate, 147.606);
  assert.equal(view.stale, false);
  assert.equal(view.fetchedAt.getTime(), T0.getTime());

  // 取得成功分は repo に保存されている
  assert.equal(repo.upsertCalls.length, 1);
  assert.equal((await repo.get('USDJPY'))?.rate, 147.606);
});

test('rateService: TTL 内のキャッシュがあれば fetchRate を呼ばず stale:false で返す', async () => {
  const clock = createClock(T0);
  const repo = createFakeRepo();
  // 10分前に取得済み(TTL 20分)
  await repo.upsert(makeRate('USDJPY', 147.0, new Date(T0.getTime() - 10 * MIN)));
  const fetchRate = createFakeFetchRate({ USDJPY: 999 });
  const service = createRateService({ repo, pairs: ['USDJPY'], ttlMinutes: 20, fetchRate, now: clock.now });

  const rates = await service.getRates();
  assert.equal(fetchRate.calls.length, 0, 'TTL 内は fetch しない');
  assert.equal(rates[0]?.rate, 147.0, 'キャッシュの値が返る');
  assert.equal(rates[0]?.stale, false);
});

test('rateService: TTL ちょうど経過(now - fetchedAt == ttl)は再取得する(fresh 条件は strict <)', async () => {
  const clock = createClock(T0);
  const repo = createFakeRepo();
  await repo.upsert(makeRate('USDJPY', 147.0, new Date(T0.getTime() - 20 * MIN)));
  const fetchRate = createFakeFetchRate({ USDJPY: 148.0 });
  const service = createRateService({ repo, pairs: ['USDJPY'], ttlMinutes: 20, fetchRate, now: clock.now });

  const rates = await service.getRates();
  assert.equal(fetchRate.calls.length, 1, 'ちょうど TTL 経過は再取得');
  assert.equal(rates[0]?.rate, 148.0);
  assert.equal(rates[0]?.stale, false);
});

test('rateService: TTL 超過で再取得に成功したら upsert で更新され stale:false', async () => {
  const clock = createClock(T0);
  const repo = createFakeRepo();
  await repo.upsert(makeRate('USDJPY', 147.0, new Date(T0.getTime() - 30 * MIN)));
  const fetchRate = createFakeFetchRate({ USDJPY: 148.2 });
  const service = createRateService({ repo, pairs: ['USDJPY'], ttlMinutes: 20, fetchRate, now: clock.now });

  const rates = await service.getRates();
  assert.equal(rates[0]?.rate, 148.2);
  assert.equal(rates[0]?.stale, false);
  assert.equal((await repo.get('USDJPY'))?.rate, 148.2, 'repo が新値に更新されている');
  assert.equal((await repo.get('USDJPY'))?.fetchedAt.getTime(), T0.getTime());
});

/* ----------------------------------------------------------- 失敗フォールバック */

test('rateService: fetch 失敗でもキャッシュがあれば stale:true で返し、エラーは伝播しない', async () => {
  const clock = createClock(T0);
  const repo = createFakeRepo();
  await repo.upsert(makeRate('USDJPY', 147.0, new Date(T0.getTime() - 30 * MIN)));
  const fetchRate = createFakeFetchRate({ USDJPY: new Error('yahoo down') });
  const service = createRateService({ repo, pairs: ['USDJPY'], ttlMinutes: 20, fetchRate, now: clock.now });

  const rates = await service.getRates(); // throw しないこと自体が検証
  assert.equal(fetchRate.calls.length, 1);
  assert.equal(rates.length, 1);
  assert.equal(rates[0]?.rate, 147.0, '古いキャッシュ値が返る');
  assert.equal(rates[0]?.stale, true);
});

test('rateService: fetch 失敗かつキャッシュ無しならそのペアは除外され、エラーは伝播しない', async () => {
  const clock = createClock(T0);
  const fetchRate = createFakeFetchRate({ USDJPY: new Error('yahoo down') });
  const service = createRateService({
    repo: createFakeRepo(),
    pairs: ['USDJPY'],
    ttlMinutes: 20,
    fetchRate,
    now: clock.now,
  });

  const rates = await service.getRates();
  assert.deepEqual(rates, [], 'キャッシュ無しの失敗ペアは結果から除外');
});

test('rateService: 複数ペアのうち1つが失敗しても他ペアは正常に返り、順序は pairs のまま', async () => {
  const clock = createClock(T0);
  const repo = createFakeRepo();
  const fetchRate = createFakeFetchRate({
    EURJPY: 171.42,
    USDJPY: new Error('boom'),
    EURUSD: 1.0842,
  });
  const service = createRateService({
    repo,
    pairs: ['EURJPY', 'USDJPY', 'EURUSD'],
    ttlMinutes: 20,
    fetchRate,
    now: clock.now,
  });

  const rates = await service.getRates();
  assert.deepEqual(
    rates.map((r) => r.pair),
    ['EURJPY', 'EURUSD'],
    '失敗した USDJPY(キャッシュ無し)だけ除外され、pairs の順序を保つ',
  );
  assert.equal(rates[0]?.rate, 171.42);
  assert.equal(rates[1]?.rate, 1.0842);
});

test('rateService: キャッシュ由来と新規取得が混在しても結果は pairs の順序を保つ', async () => {
  const clock = createClock(T0);
  const repo = createFakeRepo();
  // EURJPY だけ TTL 内キャッシュあり
  await repo.upsert(makeRate('EURJPY', 171.0, new Date(T0.getTime() - 5 * MIN)));
  const fetchRate = createFakeFetchRate({ USDJPY: 147.606 });
  const service = createRateService({
    repo,
    pairs: ['USDJPY', 'EURJPY'],
    ttlMinutes: 20,
    fetchRate,
    now: clock.now,
  });

  const rates = await service.getRates();
  assert.deepEqual(
    rates.map((r) => r.pair),
    ['USDJPY', 'EURJPY'],
  );
  assert.deepEqual(fetchRate.calls, ['USDJPY'], 'キャッシュ有効な EURJPY は fetch しない');
});

/* ----------------------------------------------------------- クールダウン */

test('rateService: 失敗後 failureCooldownMs(既定 60000)以内は同じペアを再 fetch しない', async () => {
  const clock = createClock(T0);
  const repo = createFakeRepo();
  await repo.upsert(makeRate('USDJPY', 147.0, new Date(T0.getTime() - 30 * MIN)));
  const fetchRate = createFakeFetchRate({ USDJPY: new Error('down') });
  const service = createRateService({ repo, pairs: ['USDJPY'], ttlMinutes: 20, fetchRate, now: clock.now });

  await service.getRates();
  assert.equal(fetchRate.calls.length, 1);

  // 30秒後: クールダウン中 → fetch せずキャッシュを stale:true で返す
  clock.current = new Date(T0.getTime() + 30_000);
  const during = await service.getRates();
  assert.equal(fetchRate.calls.length, 1, 'クールダウン中は再 fetch しない');
  assert.equal(during[0]?.rate, 147.0);
  assert.equal(during[0]?.stale, true);

  // 59秒後: まだクールダウン中
  clock.current = new Date(T0.getTime() + 59_000);
  await service.getRates();
  assert.equal(fetchRate.calls.length, 1);
});

test('rateService: クールダウン経過後は再度 fetchRate を試みる(成功したら stale:false に戻る)', async () => {
  const clock = createClock(T0);
  const repo = createFakeRepo();
  await repo.upsert(makeRate('USDJPY', 147.0, new Date(T0.getTime() - 30 * MIN)));
  const behavior: Record<string, number | Error> = { USDJPY: new Error('down') };
  const fetchRate = createFakeFetchRate(behavior);
  const service = createRateService({ repo, pairs: ['USDJPY'], ttlMinutes: 20, fetchRate, now: clock.now });

  await service.getRates();
  assert.equal(fetchRate.calls.length, 1);

  // クールダウン(既定 60000ms)経過後に復旧している
  behavior['USDJPY'] = 149.9;
  clock.current = new Date(T0.getTime() + 61_000);
  const after = await service.getRates();
  assert.equal(fetchRate.calls.length, 2, 'クールダウン経過後は再試行する');
  assert.equal(after[0]?.rate, 149.9);
  assert.equal(after[0]?.stale, false);
  assert.equal((await repo.get('USDJPY'))?.rate, 149.9, '復旧値は upsert される');
});

test('rateService: failureCooldownMs を指定した場合はその時間で再試行が解禁される', async () => {
  const clock = createClock(T0);
  const fetchRate = createFakeFetchRate({ USDJPY: new Error('down') });
  const service = createRateService({
    repo: createFakeRepo(),
    pairs: ['USDJPY'],
    ttlMinutes: 20,
    fetchRate,
    now: clock.now,
    failureCooldownMs: 5_000,
  });

  await service.getRates();
  assert.equal(fetchRate.calls.length, 1);

  clock.current = new Date(T0.getTime() + 4_000);
  await service.getRates();
  assert.equal(fetchRate.calls.length, 1, '4秒後はまだクールダウン中');

  clock.current = new Date(T0.getTime() + 6_000);
  await service.getRates();
  assert.equal(fetchRate.calls.length, 2, '5秒経過後は再試行');
});

test('rateService: クールダウンはペアごとに独立(失敗ペアが他ペアの取得を妨げない)', async () => {
  const clock = createClock(T0);
  const repo = createFakeRepo();
  const behavior: Record<string, number | Error> = {
    USDJPY: new Error('down'),
    EURJPY: 171.42,
  };
  const fetchRate = createFakeFetchRate(behavior);
  const service = createRateService({
    repo,
    pairs: ['USDJPY', 'EURJPY'],
    ttlMinutes: 20,
    fetchRate,
    now: clock.now,
  });

  await service.getRates();
  assert.deepEqual(fetchRate.calls, ['USDJPY', 'EURJPY']);

  // 直後(EURJPY は TTL 内キャッシュ、USDJPY はクールダウン)→ どちらも fetch しない
  clock.current = new Date(T0.getTime() + 10_000);
  const rates = await service.getRates();
  assert.equal(fetchRate.calls.length, 2);
  assert.deepEqual(
    rates.map((r) => r.pair),
    ['EURJPY'],
    'USDJPY はキャッシュ無しのため除外、EURJPY はキャッシュから返る',
  );
  assert.equal(rates[0]?.stale, false);
});
