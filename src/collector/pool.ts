/**
 * 依存追加なしの軽量並列実行プール。
 * 各ワーカーが共有インデックスを取り合って次のアイテムを処理するため、
 * 同時実行数は常に min(concurrency, items.length) を超えない。
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      const item = items[current] as T;
      results[current] = await worker(item, current);
    }
  }

  const normalizedConcurrency = normalizeConcurrency(concurrency);
  const workerCount = Math.max(1, Math.min(normalizedConcurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  return results;
}

/** concurrency が非有限(NaN 等)または不正な値のときに使う既定値。安全側(直列)に倒す。 */
const FALLBACK_CONCURRENCY = 1;

/**
 * concurrency を検証・正規化する。
 *
 * - NaN や Infinity など有限数でない値は、Math.max/Math.min に伝播すると
 *   NaN が全体を汚染したり Array.from({length: Infinity}) が例外になったりするため、
 *   既定値 (FALLBACK_CONCURRENCY) にフォールバックする(呼び出し側の入力不備で
 *   収集全体を止めないため、ここでは例外を投げない方針)。
 * - 有限だが 1 未満の値(0 や 0.5、負数)は Math.floor 後 1 に切り上げる。
 */
function normalizeConcurrency(concurrency: number): number {
  if (!Number.isFinite(concurrency)) return FALLBACK_CONCURRENCY;
  const floored = Math.floor(concurrency);
  return floored < 1 ? 1 : floored;
}
