import type { ExchangeRate } from '../domain/types.ts';
import type { ExchangeRateRepository } from '../domain/repositories.ts';

/**
 * 為替レートの lazy TTL キャッシュ(設計書 §14.1)。
 * アプリ内に cron は無いため、表示リクエスト時に鮮度を判定し、
 * TTL 超過時のみ取得して DB キャッシュを更新する。
 * 取得失敗はここで吸収し、呼び出し元(ダッシュボード)へは伝播させない。
 */

export interface RateView extends ExchangeRate {
  /** true = TTL 切れだが再取得に失敗し、古いキャッシュを表示している。 */
  stale: boolean;
}

export interface RateServiceOptions {
  repo: ExchangeRateRepository;
  /** 表示する通貨ペア(順序保持)。空なら常に []。 */
  pairs: string[];
  ttlMinutes: number;
  fetchRate: (pair: string, now: Date) => Promise<ExchangeRate>;
  now?: () => Date;
  /** 取得失敗後にこの時間は再試行しない(連続アクセスで外部APIを叩き続けない)。 */
  failureCooldownMs?: number;
}

const DEFAULT_FAILURE_COOLDOWN_MS = 60_000;

export interface RateService {
  getRates(): Promise<RateView[]>;
}

export function createRateService(options: RateServiceOptions): RateService {
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMinutes * 60_000;
  const cooldownMs = options.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS;
  /** pair → 最後に取得失敗した時刻(プロセス内のみ。再起動でリセットされてよい)。 */
  const lastFailureAt = new Map<string, number>();

  async function getRate(pair: string, at: Date): Promise<RateView | null> {
    const cached = await options.repo.get(pair);
    if (cached && at.getTime() - cached.fetchedAt.getTime() < ttlMs) {
      return { ...cached, stale: false };
    }

    const failedAt = lastFailureAt.get(pair);
    const inCooldown = failedAt !== undefined && at.getTime() - failedAt < cooldownMs;
    if (!inCooldown) {
      try {
        const fresh = await options.fetchRate(pair, at);
        await options.repo.upsert(fresh);
        lastFailureAt.delete(pair);
        return { ...fresh, stale: false };
      } catch (err) {
        lastFailureAt.set(pair, at.getTime());
        // 恒常的失敗(API仕様変更等)に気づけるよう1行だけ残す。エラーメッセージは
        // ステータスコード等のみで URL・応答ボディ・秘密情報を含まない。
        // eslint-disable-next-line no-console
        console.warn(`exchange rate fetch failed: ${pair}: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    }
    return cached ? { ...cached, stale: true } : null;
  }

  return {
    async getRates(): Promise<RateView[]> {
      const at = now();
      const views: RateView[] = [];
      for (const pair of options.pairs) {
        let view: RateView | null = null;
        try {
          view = await getRate(pair, at);
        } catch {
          // リポジトリ障害等もダッシュボード表示は止めない(そのペアを落とすだけ)。
        }
        if (view) views.push(view);
      }
      return views;
    },
  };
}
