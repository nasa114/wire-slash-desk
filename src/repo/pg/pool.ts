import { Pool } from 'pg';

interface CreatePgPoolOptions {
  /**
   * アイドル接続がサーバー側から切断された際の通知先。既定は console.error。
   * 差し替える場合も err オブジェクト全体をログにダンプしないこと(pg のエラーは
   * 接続関連プロパティを含み得る)。err.message のみ記録するのが安全。
   */
  onIdleClientError?: (err: Error) => void;
}

/**
 * アプリ共通の Pool 生成。
 *
 * Neon 等の自動サスペンドする PostgreSQL では、サスペンド時にプール内の
 * アイドル接続がサーバー側から切断される。node-postgres はこれを Pool の
 * 'error' イベントとして発火するため、リスナーが無いと Node.js の仕様
 * (unhandled 'error') によりプロセスごとクラッシュする。ここで必ず
 * リスナーを登録し、記録だけして継続する(切断済み接続はプールから除去
 * されるため、次のクエリは新規接続で成功する)。
 *
 * SSL は接続文字列の `?sslmode=verify-full` で有効化する(マネージド PostgreSQL
 * への接続時に必要。コード側の追加設定は不要)。pg 8.x は `require` を
 * verify-full 相当に扱うが、pg 9.0 で libpq 準拠(証明書検証なし)に変わる
 * 予告があるため、明示的に verify-full を指定すること。
 */
export function createPgPool(connectionString: string, options: CreatePgPoolOptions = {}): Pool {
  const onIdleClientError =
    options.onIdleClientError ??
    ((err: Error) => {
      // 接続文字列(認証情報)はログに出さない。err.message のみ記録する。
      console.error(`pg pool: idle client error (continuing): ${err.message}`);
    });
  const pool = new Pool({ connectionString });
  pool.on('error', onIdleClientError);
  return pool;
}
