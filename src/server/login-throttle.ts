/**
 * ログイン総当たり対策(設計書 §7 / docs/004_KnownLimitations.md §7 の実装)。
 *
 * 目的: `/login` へのオンライン総当たり・パスワードスプレーを、インメモリの
 * スライディングウィンドウで抑制する。ユーザー名と送信元 IP の**両方**をキーにし、
 * いずれかが閾値に達したら limited とする:
 *   - ユーザー名キー: 特定アカウントへの集中攻撃を防ぐ(保護対象の資産)。
 *   - IP キー: 単一送信元からのユーザー名総当たり(スプレー)を防ぐ。
 *
 * 純粋なインメモリ実装で外部依存なし。単一プロセス・単一オーナー運用が前提
 * (水平スケール時はリバースプロキシ/共有ストアでの制限に置き換える)。
 * 秘密情報(パスワード等)は一切保持しない。キーは呼び出し側が正規化して渡す。
 */

export interface LoginThrottleOptions {
  /** 監視ウィンドウ(ミリ秒)。既定 15 分。 */
  windowMs?: number;
  /** 1 キーあたりウィンドウ内で許容する失敗回数。これに達すると limited。既定 5。 */
  maxPerKey?: number;
  /** 追跡キーの上限(メモリDoS対策)。超過分は直近性の低いキーから退避。既定 10,000。 */
  maxTrackedKeys?: number;
  /** 時刻源(ミリ秒)。テストで注入する。既定 Date.now。 */
  now?: () => number;
}

export interface ThrottleDecision {
  /** true なら現在ブロック対象(429 を返す)。 */
  limited: boolean;
  /** limited のとき、再試行までの秒数(最古の失敗が窓を抜けるまで)。非 limited は 0。 */
  retryAfterSec: number;
}

const DEFAULT_WINDOW_MS = 15 * 60_000;
const DEFAULT_MAX_PER_KEY = 5;
const DEFAULT_MAX_TRACKED_KEYS = 10_000;

export class LoginThrottle {
  private readonly windowMs: number;
  private readonly maxPerKey: number;
  private readonly maxTrackedKeys: number;
  private readonly now: () => number;
  /** キー -> ウィンドウ内の失敗タイムスタンプ(昇順)。 */
  private readonly hits = new Map<string, number[]>();

  constructor(options: LoginThrottleOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxPerKey = options.maxPerKey ?? DEFAULT_MAX_PER_KEY;
    this.maxTrackedKeys = options.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS;
    this.now = options.now ?? Date.now;
  }

  /** 与えられたキー群のいずれかが閾値に達していれば limited。 */
  check(keys: readonly string[]): ThrottleDecision {
    const nowMs = this.now();
    let retryAfterSec = 0;
    for (const key of keys) {
      const times = this.prune(key, nowMs);
      if (times.length >= this.maxPerKey) {
        const oldest = times[0] as number;
        const remainingMs = oldest + this.windowMs - nowMs;
        const sec = Math.max(1, Math.ceil(remainingMs / 1000));
        if (sec > retryAfterSec) retryAfterSec = sec;
      }
    }
    return { limited: retryAfterSec > 0, retryAfterSec };
  }

  /** 失敗を記録する(全キーに1件ずつ加算)。 */
  recordFailure(keys: readonly string[]): void {
    const nowMs = this.now();
    for (const key of keys) {
      const times = this.prune(key, nowMs);
      times.push(nowMs);
      this.hits.set(key, times);
    }
    this.evictIfNeeded();
  }

  /** 成功時などにキーの失敗履歴を消す。 */
  reset(keys: readonly string[]): void {
    for (const key of keys) this.hits.delete(key);
  }

  /** 現在追跡中のキー数(テスト・監視用)。 */
  size(): number {
    return this.hits.size;
  }

  /** キーの失敗履歴からウィンドウ外を除去し、残りを返す(空なら削除)。 */
  private prune(key: string, nowMs: number): number[] {
    const times = this.hits.get(key);
    if (times === undefined) return [];
    const cutoff = nowMs - this.windowMs;
    // 昇順なので、cutoff より新しい最初の位置を見つけて切り出す。
    let i = 0;
    while (i < times.length && (times[i] as number) <= cutoff) i++;
    const kept = i === 0 ? times : times.slice(i);
    if (kept.length === 0) {
      this.hits.delete(key);
      return [];
    }
    if (kept !== times) this.hits.set(key, kept);
    return kept;
  }

  /** 追跡キー数が上限を超えたら、直近の失敗が古いキーから削除する。 */
  private evictIfNeeded(): void {
    if (this.hits.size <= this.maxTrackedKeys) return;
    // 各キーの「最新失敗時刻」で昇順ソートし、古いものから落とす。
    const entries = [...this.hits.entries()].sort(
      (a, b) => (a[1][a[1].length - 1] as number) - (b[1][b[1].length - 1] as number),
    );
    const removeCount = this.hits.size - this.maxTrackedKeys;
    for (let i = 0; i < removeCount; i++) {
      const entry = entries[i];
      if (entry) this.hits.delete(entry[0]);
    }
  }
}
