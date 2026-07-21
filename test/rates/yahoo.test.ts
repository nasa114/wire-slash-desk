import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchYahooRate, type FetchYahooRateOptions } from '../../src/rates/yahoo.ts';
import { ValidationError } from '../../src/domain/errors.ts';

/**
 * Yahoo Finance chart API クライアントのテスト(T4-3、設計書 §14)。
 * 外部ネットワークは一切使わず、fetchFn 注入の fake で遮断する。
 */

const UA = 'personal-rss-reader/0.1 (+test@example.com)';
const NOW = new Date('2026-07-21T09:00:00Z');

/** fake fetch が記録する1回分の呼び出し(method / redirect / headers / signal を正規化)。 */
interface RecordedCall {
  url: string;
  method: string;
  redirect: RequestInit['redirect'] | undefined;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
}

type RecordingFetch = typeof fetch & { calls: RecordedCall[] };

/**
 * ネットワーク遮断用 fake fetch(test/collector/fake-fetch.ts と同趣旨)。
 * 実装が (url, init) 形式でも Request オブジェクト形式でも検証できるよう正規化する。
 */
function createRecordingFetch(
  handler: (call: RecordedCall, callIndex: number) => Response | Promise<Response>,
): RecordingFetch {
  const calls: RecordedCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: RecordedCall =
      input instanceof Request
        ? {
            url: input.url,
            method: input.method,
            redirect: input.redirect,
            headers: headersToRecord(input.headers),
            signal: init?.signal ?? input.signal ?? undefined,
          }
        : {
            url: input.toString(),
            method: (init?.method ?? 'GET').toUpperCase(),
            redirect: init?.redirect,
            headers: normalizeHeaders(init?.headers),
            signal: init?.signal ?? undefined,
          };
    const callIndex = calls.length;
    calls.push(call);
    return handler(call, callIndex);
  }) as RecordingFetch;
  fn.calls = calls;
  return fn;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function normalizeHeaders(headers: RequestInit['headers']): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return headersToRecord(headers);
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** ヘッダ名の大小差を吸収して取得する。 */
function header(call: RecordedCall, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(call.headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

const VALID_META = {
  currency: 'JPY',
  symbol: 'USDJPY=X',
  regularMarketPrice: 147.606,
  chartPreviousClose: 147.211,
  regularMarketTime: 1753077600,
};

function chartBody(meta: unknown): string {
  return JSON.stringify({ chart: { result: [{ meta }], error: null } });
}

function ok200(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

function options(fetchFn: typeof fetch, extra: Partial<FetchYahooRateOptions> = {}): FetchYahooRateOptions {
  return { userAgent: UA, trustEgressProxy: false, fetchFn, ...extra };
}

/* ------------------------------------------------------- pair バリデーション */

test('fetchYahooRate: pair が /^[A-Z]{6}$/ に合わなければ ValidationError で fetchFn は呼ばれない', async () => {
  const fetchFn = createRecordingFetch(() => ok200(chartBody(VALID_META)));
  const badPairs = ['usdjpy', 'USD/JPY', 'USDJP', 'USDJPYX', 'USDJPY=X', 'USD JPY', '123456', ''];
  for (const pair of badPairs) {
    await assert.rejects(
      async () => fetchYahooRate(pair, NOW, options(fetchFn)),
      ValidationError,
      `pair=${JSON.stringify(pair)} は ValidationError`,
    );
  }
  assert.equal(fetchFn.calls.length, 0, '不正 pair では fetchFn を一度も呼ばない');
});

/* ------------------------------------------------------------- リクエスト形 */

test('fetchYahooRate: URL は chart API 固定・GET・redirect manual・User-Agent 指定', async () => {
  const fetchFn = createRecordingFetch(() => ok200(chartBody(VALID_META)));
  await fetchYahooRate('USDJPY', NOW, options(fetchFn));

  assert.equal(fetchFn.calls.length, 1, '呼び出しは1回');
  const call = fetchFn.calls[0]!;
  assert.equal(
    call.url,
    'https://query1.finance.yahoo.com/v8/finance/chart/USDJPY=X?range=1d&interval=1d',
  );
  assert.equal(call.method, 'GET');
  assert.equal(call.redirect, 'manual', 'リダイレクトは追わない設定であること');
  assert.equal(header(call, 'user-agent'), UA);
});

test('fetchYahooRate: pair は URL に反映される(EURUSD)', async () => {
  const fetchFn = createRecordingFetch(() =>
    ok200(chartBody({ ...VALID_META, symbol: 'EURUSD=X', regularMarketPrice: 1.0842 })),
  );
  const rate = await fetchYahooRate('EURUSD', NOW, options(fetchFn));
  assert.equal(
    fetchFn.calls[0]?.url,
    'https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?range=1d&interval=1d',
  );
  assert.equal(rate.pair, 'EURUSD');
  assert.equal(rate.rate, 1.0842);
});

/* ----------------------------------------------------------- HTTP エラー系 */

test('fetchYahooRate: 3xx はリダイレクトを追わず Error', async () => {
  for (const status of [301, 302, 307]) {
    const fetchFn = createRecordingFetch(
      () => new Response(null, { status, headers: { location: 'https://evil.example.com/' } }),
    );
    await assert.rejects(
      async () => fetchYahooRate('USDJPY', NOW, options(fetchFn)),
      Error,
      `${status} は Error`,
    );
    assert.equal(fetchFn.calls.length, 1, 'リダイレクト先への2回目の fetch はしない');
  }
});

test('fetchYahooRate: 200 以外(404 / 429 / 500)は Error', async () => {
  for (const status of [404, 429, 500]) {
    const fetchFn = createRecordingFetch(() => new Response('error body', { status }));
    await assert.rejects(
      async () => fetchYahooRate('USDJPY', NOW, options(fetchFn)),
      Error,
      `${status} は Error`,
    );
  }
});

/* ------------------------------------------------------------------- 正常系 */

test('fetchYahooRate: 正常レスポンスから ExchangeRate を組み立てる', async () => {
  const fetchFn = createRecordingFetch(() => ok200(chartBody(VALID_META)));
  const rate = await fetchYahooRate('USDJPY', NOW, options(fetchFn));

  assert.equal(rate.pair, 'USDJPY');
  assert.equal(rate.rate, 147.606);
  assert.equal(rate.prevClose, 147.211);
  assert.ok(rate.marketTime instanceof Date);
  assert.equal(rate.marketTime.getTime(), 1753077600 * 1000, 'unix 秒 → ミリ秒の Date');
  assert.equal(rate.fetchedAt.getTime(), NOW.getTime(), 'fetchedAt は引数 now');
});

/* --------------------------------------------------------- 防御的パース */

test('fetchYahooRate: regularMarketPrice が正の有限数でなければ Error', async () => {
  const badPrices: unknown[] = [undefined, null, 0, -1, 'abc', '147.6', Number.NaN];
  for (const price of badPrices) {
    const meta: Record<string, unknown> = { ...VALID_META };
    if (price === undefined) {
      delete meta['regularMarketPrice'];
    } else {
      meta['regularMarketPrice'] = price;
    }
    const fetchFn = createRecordingFetch(() => ok200(chartBody(meta)));
    await assert.rejects(
      async () => fetchYahooRate('USDJPY', NOW, options(fetchFn)),
      Error,
      `regularMarketPrice=${String(price)} は Error`,
    );
  }
  // JSON.parse('1e999') は Infinity になる — 有限数でないので Error
  const infFetch = createRecordingFetch(() =>
    ok200(chartBody(VALID_META).replace('147.606', '1e999')),
  );
  await assert.rejects(async () => fetchYahooRate('USDJPY', NOW, options(infFetch)), Error);
});

test('fetchYahooRate: chartPreviousClose が有限数でなければ prevClose は null(エラーにしない)', async () => {
  const cases: unknown[] = [undefined, null, 'abc'];
  for (const prev of cases) {
    const meta: Record<string, unknown> = { ...VALID_META };
    if (prev === undefined) {
      delete meta['chartPreviousClose'];
    } else {
      meta['chartPreviousClose'] = prev;
    }
    const fetchFn = createRecordingFetch(() => ok200(chartBody(meta)));
    const rate = await fetchYahooRate('USDJPY', NOW, options(fetchFn));
    assert.equal(rate.prevClose, null, `chartPreviousClose=${String(prev)} は null`);
    assert.equal(rate.rate, 147.606, 'rate は正常に返る');
  }
});

test('fetchYahooRate: regularMarketTime が有限数でなければ marketTime は null(エラーにしない)', async () => {
  const cases: unknown[] = [undefined, null, 'abc'];
  for (const time of cases) {
    const meta: Record<string, unknown> = { ...VALID_META };
    if (time === undefined) {
      delete meta['regularMarketTime'];
    } else {
      meta['regularMarketTime'] = time;
    }
    const fetchFn = createRecordingFetch(() => ok200(chartBody(meta)));
    const rate = await fetchYahooRate('USDJPY', NOW, options(fetchFn));
    assert.equal(rate.marketTime, null, `regularMarketTime=${String(time)} は null`);
  }
});

test('fetchYahooRate: 構造が壊れた JSON / 非 JSON は Error(クラッシュしない)', async () => {
  const bodies = [
    'not json at all',
    '{}',
    '{"chart":null}',
    '{"chart":{"result":null}}',
    '{"chart":{"result":[]}}',
    '{"chart":{"result":[{}]}}',
    '{"chart":{"result":[{"meta":null}]}}',
    '[]',
    '"string"',
  ];
  for (const body of bodies) {
    const fetchFn = createRecordingFetch(() => ok200(body));
    await assert.rejects(
      async () => fetchYahooRate('USDJPY', NOW, options(fetchFn)),
      Error,
      `body=${body.slice(0, 40)} は Error`,
    );
  }
});

/* ------------------------------------------------------- ボディサイズ上限 */

test('fetchYahooRate: 応答ボディが 1MB を超えたら Error', async () => {
  // JSON としては正しい(サイズ以外に落ちる理由がない)巨大ボディ
  const huge = JSON.stringify({
    chart: { result: [{ meta: VALID_META }], error: null },
    pad: 'x'.repeat(1_100_000),
  });
  assert.ok(huge.length > 1_048_576, 'フィクスチャは 1MB 超であること');
  const fetchFn = createRecordingFetch(() => ok200(huge));
  await assert.rejects(async () => fetchYahooRate('USDJPY', NOW, options(fetchFn)), Error);
});

/* ------------------------------------------------------------- タイムアウト */

test('fetchYahooRate: timeoutMs 経過で中断される(応答が返らない場合)', async () => {
  const fetchFn = createRecordingFetch(
    (call) =>
      new Promise<Response>((_resolve, reject) => {
        // タイムアウト(AbortSignal)が実装されていなければ 2 秒でテストを落とす
        const guard = setTimeout(
          () => reject(new Error('timeout not enforced: fetch was never aborted')),
          2_000,
        );
        const abort = () => {
          clearTimeout(guard);
          reject(call.signal?.reason ?? new Error('aborted'));
        };
        if (call.signal?.aborted) {
          abort();
        } else {
          call.signal?.addEventListener('abort', abort, { once: true });
        }
      }),
  );
  await assert.rejects(
    async () => fetchYahooRate('USDJPY', NOW, options(fetchFn, { timeoutMs: 50 })),
    Error,
  );
});
