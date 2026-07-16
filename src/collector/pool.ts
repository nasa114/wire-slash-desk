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

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  return results;
}
