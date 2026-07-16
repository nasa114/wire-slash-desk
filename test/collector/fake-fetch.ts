/**
 * ネットワークアクセス禁止のテスト用 fake fetch。
 * collector には CollectOptions.fetchFn として注入する。
 */
export interface FetchCall {
  url: string;
  headers: Record<string, string>;
  /** collector が渡した AbortSignal(未指定なら undefined)。タイムアウト検証用。 */
  signal?: AbortSignal;
}

export type FakeFetch = typeof fetch & { calls: FetchCall[] };

export type FakeFetchHandler = (
  url: string,
  headers: Record<string, string>,
  callIndex: number,
  signal?: AbortSignal,
) => Response | Promise<Response>;

export function createFakeFetch(handler: FakeFetchHandler): FakeFetch {
  const calls: FetchCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = normalizeHeaders(init?.headers);
    const signal = init?.signal ?? undefined;
    const callIndex = calls.length;
    calls.push({ url, headers, signal });
    return handler(url, headers, callIndex, signal);
  }) as FakeFetch;
  fn.calls = calls;
  return fn;
}

function normalizeHeaders(headers: RequestInit['headers']): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
