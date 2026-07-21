import type { ExchangeRate } from '../domain/types.ts';
import { ValidationError } from '../domain/errors.ts';
import { assertProxySafeHttpUrl } from '../server/ssrf.ts';

/**
 * Yahoo Finance chart API から為替レートを1件取得する(設計書 §14)。
 * 宛先は固定ホストのみ・リダイレクト不追従・応答サイズ上限つき。
 * 非公式APIのため、応答は meta の必要フィールドだけを防御的に読む。
 */

const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const PAIR_PATTERN = /^[A-Z]{6}$/;
const DEFAULT_TIMEOUT_MS = 3_500;
const MAX_BODY_BYTES = 1024 * 1024;

export interface FetchYahooRateOptions {
  userAgent: string;
  /**
   * egress 構成の明示用(main.ts が config と同値を渡す)。宛先が固定ホストのため
   * 検査自体は構成によらず非 DNS(assertProxySafeHttpUrl)で共通。
   */
  trustEgressProxy: boolean;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new Error('yahoo_response_too_large');
    return buf.toString('utf8');
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total > maxBytes) throw new Error('yahoo_response_too_large');
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export async function fetchYahooRate(
  pair: string,
  now: Date,
  options: FetchYahooRateOptions,
): Promise<ExchangeRate> {
  // URL 注入防止: pair はホワイトリスト形式に一致した場合のみ URL に組み込む。
  if (!PAIR_PATTERN.test(pair)) {
    throw new ValidationError(`invalid currency pair format: expected [A-Z]{6}`);
  }
  const url = `${YAHOO_CHART_BASE}${pair}=X?range=1d&interval=1d`;

  // 宛先はコード内定数の固定ホストで攻撃者が URL を制御できず、リダイレクトも
  // 追わないため、DNS 事前解決(assertPublicHttpUrl)は不要。防御多層化として
  // スキーム+IP リテラル検査のみ通す(collector と異なり feed_url のような
  // 外部入力を扱わない。設計書 §14.3)。
  assertProxySafeHttpUrl(url);

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const res = await fetchFn(url, {
    headers: { 'User-Agent': options.userAgent, Accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (res.status >= 300 && res.status < 400) {
    try {
      await res.body?.cancel?.();
    } catch {
      // ignore
    }
    throw new Error(`yahoo_unexpected_redirect: ${res.status}`);
  }
  if (res.status !== 200) {
    try {
      await res.body?.cancel?.();
    } catch {
      // ignore
    }
    throw new Error(`yahoo_http_error: ${res.status}`);
  }

  const text = await readBodyCapped(res, MAX_BODY_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('yahoo_invalid_json');
  }

  const meta = (
    ((parsed as { chart?: { result?: unknown[] } })?.chart?.result?.[0] ?? {}) as {
      meta?: Record<string, unknown>;
    }
  ).meta;
  const rate = toFiniteNumber(meta?.['regularMarketPrice']);
  if (rate === null || rate <= 0) throw new Error('yahoo_missing_market_price');

  const prevClose = toFiniteNumber(meta?.['chartPreviousClose']);
  // 有限数でも Date 範囲外の値(例: 1e15 秒)だと Invalid Date が下流の描画で
  // RangeError を起こすため、unix 秒として妥当な範囲(〜西暦2100年頃)に限定する。
  const marketTimeSec = toFiniteNumber(meta?.['regularMarketTime']);
  const marketTime =
    marketTimeSec !== null && marketTimeSec > 0 && marketTimeSec < 4.1e9
      ? new Date(marketTimeSec * 1000)
      : null;

  return {
    pair,
    rate,
    prevClose,
    marketTime,
    fetchedAt: now,
  };
}
