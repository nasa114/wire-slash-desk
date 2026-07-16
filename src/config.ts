/** アプリ全体の構成。環境変数を一箇所で構造化して読む(設計書 §7, §8)。 */
export interface AppConfig {
  port: number;
  databaseUrl: string | undefined;
  mcpBearerToken: string | undefined;
  collectorToken: string | undefined;
  /** true のときのみ本文をキャッシュ永続化する(既定 false)。設計書 §6。 */
  cacheFulltext: boolean;
  /** User-Agent に載せる連絡先(礼儀)。設計書 §5。 */
  collectorContact: string | undefined;
  nodeEnv: string;
}

function readString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const portRaw = readString(env, 'PORT');
  const port = portRaw !== undefined ? Number.parseInt(portRaw, 10) : 3000;
  return {
    port: Number.isFinite(port) && port > 0 ? port : 3000,
    databaseUrl: readString(env, 'DATABASE_URL'),
    mcpBearerToken: readString(env, 'MCP_BEARER_TOKEN'),
    collectorToken: readString(env, 'COLLECTOR_TOKEN'),
    // 'true' のみを有効とみなす。それ以外(未設定・'false'・'1' など)は false。
    cacheFulltext: readString(env, 'CACHE_FULLTEXT') === 'true',
    collectorContact: readString(env, 'COLLECTOR_CONTACT'),
    nodeEnv: readString(env, 'NODE_ENV') ?? 'development',
  };
}

/** 連絡先つき User-Agent 文字列(設計書 §5)。 */
export function buildUserAgent(contact: string | undefined): string {
  return contact ? `personal-rss-reader/0.1 (+${contact})` : 'personal-rss-reader/0.1';
}
