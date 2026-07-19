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
  /**
   * egress プロキシ経由の環境(ローカル DNS 不可)で true。
   * SSRF ガードの DNS 事前解決をスキップし、接続先制御をプロキシの
   * 許可リストに委譲する。直接エグレス環境では必ず false のままにすること。
   */
  trustEgressProxy: boolean;
  /**
   * セッション Cookie の Secure 属性。SESSION_COOKIE_SECURE=true/false で明示指定、
   * 未設定なら NODE_ENV=production のとき true(HTTPS 前提)。
   */
  cookieSecure: boolean;
  /**
   * MCP OAuth 2.1(T4-2)の issuer URL(外部から到達できる自サイトのオリジン。
   * 例: https://reader.example)。未設定なら OAuth エンドポイントは無効で、
   * /mcp は静的 Bearer のみ受け付ける(従来動作)。
   */
  oauthIssuerUrl: string | undefined;
  /**
   * 初回セットアップ(/setup)を保護する任意のワンタイムトークン(PT-001 対策)。
   * 設定時は /setup フォームにこのトークンの入力を要求し、一致した場合のみ
   * 管理ユーザー作成を許可する。未設定なら従来どおりトークンなしで開放する
   * (公開網へは信頼できる状態になるまで晒さない運用が前提)。
   */
  setupToken: string | undefined;
  nodeEnv: string;
}

function readString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** 設定不備エラー(起動時 fail fast 用)。メッセージに秘密の値は含めない。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * TRUST_EGRESS_PROXY=true が SSRF ガードの DNS 事前解決をスキップする前提として、
 * 実トラフィックが本当にプロキシを通る環境変数一式が揃っているかを検証する。
 *
 * `TRUST_EGRESS_PROXY=true` を SSRF 防御の空洞化なしに使うには、
 * - HTTPS_PROXY / HTTP_PROXY(大文字小文字どちらか)が設定されていること
 * - Node の fetch(undici)にプロキシ環境変数を読ませる NODE_USE_ENV_PROXY=1 が
 *   設定されていること(これが無いと HTTPS_PROXY 等が事実上無視され、
 *   直接エグレスしてしまう)
 * の両方が必要。欠けていれば ConfigError を投げて起動を拒否する。
 * エラーメッセージには欠落している変数名のみを含め、値そのものは含めない。
 */
export function validateEgressProxyTrust(
  env: NodeJS.ProcessEnv,
  trustEgressProxy: boolean,
): void {
  if (!trustEgressProxy) return;

  const missing: string[] = [];
  const hasHttpsProxy =
    readString(env, 'HTTPS_PROXY') !== undefined || readString(env, 'https_proxy') !== undefined;
  const hasHttpProxy =
    readString(env, 'HTTP_PROXY') !== undefined || readString(env, 'http_proxy') !== undefined;
  const hasNodeUseEnvProxy = readString(env, 'NODE_USE_ENV_PROXY') === '1';

  if (!hasHttpsProxy) missing.push('HTTPS_PROXY (or https_proxy)');
  if (!hasHttpProxy) missing.push('HTTP_PROXY (or http_proxy)');
  if (!hasNodeUseEnvProxy) missing.push('NODE_USE_ENV_PROXY=1');

  if (missing.length > 0) {
    throw new ConfigError(
      `TRUST_EGRESS_PROXY=true requires the following environment variable(s) to be set ` +
        `(otherwise traffic may bypass the egress proxy and the SSRF guard becomes a no-op): ` +
        `${missing.join(', ')}`,
    );
  }
}

/**
 * OAUTH_ISSUER_URL の検証。RFC 8414 の issuer 要件(https・query/fragment なし)に
 * 合わせる。ローカル動作確認用に localhost / 127.0.0.1 のみ http を許す
 * (SDK 側 checkIssuerUrl と同じ緩和)。不正なら ConfigError で起動を拒否する。
 */
function validateOAuthIssuerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('OAUTH_ISSUER_URL is not a valid URL');
  }
  const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !isLoopback) {
    throw new ConfigError('OAUTH_ISSUER_URL must be https (http is allowed only for localhost)');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new ConfigError('OAUTH_ISSUER_URL must not contain a query or fragment');
  }
  return url.href;
}

/**
 * PT-003(直接egress構成の fail-closed)。本番(NODE_ENV=production)で egress
 * プロキシを信頼しない=アプリが直接インターネットへ出る構成は、DNS rebinding
 * TOCTOU(docs/004 §1)の余地が残る。既定では起動を拒否し、リスクを理解した
 * 上で直接egressを選ぶ場合のみ ALLOW_DIRECT_EGRESS=true で明示的にオプトアウト
 * させる(fail closed)。開発環境や proxy 信頼構成では何もしない。
 */
export function validateDirectEgressInProduction(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
  trustEgressProxy: boolean,
): void {
  if (nodeEnv !== 'production' || trustEgressProxy) return;
  if (readString(env, 'ALLOW_DIRECT_EGRESS') === 'true') return;
  throw new ConfigError(
    'refusing to start: NODE_ENV=production without an egress proxy (TRUST_EGRESS_PROXY=true) ' +
      'leaves the SSRF guard exposed to DNS rebinding. Route egress through the proxy, or set ' +
      'ALLOW_DIRECT_EGRESS=true to explicitly accept the risk of direct egress.',
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const portRaw = readString(env, 'PORT');
  const port = portRaw !== undefined ? Number.parseInt(portRaw, 10) : 3000;
  // 'true' のみを有効とみなす。それ以外(未設定・'false'・'1' など)は false。
  const trustEgressProxy = readString(env, 'TRUST_EGRESS_PROXY') === 'true';
  validateEgressProxyTrust(env, trustEgressProxy);
  // 大小差での取り違えを避けるため小文字に正規化する('Production' 等でも本番判定を
  // 取りこぼさない)。これで fail-closed(直接egress)と Secure Cookie の本番判定が
  // 一貫して働く(PT-003 レビュー指摘)。
  const nodeEnv = (readString(env, 'NODE_ENV') ?? 'development').toLowerCase();
  validateDirectEgressInProduction(env, nodeEnv, trustEgressProxy);
  const cookieSecureRaw = readString(env, 'SESSION_COOKIE_SECURE');
  const cookieSecure =
    cookieSecureRaw !== undefined ? cookieSecureRaw === 'true' : nodeEnv === 'production';
  const oauthIssuerRaw = readString(env, 'OAUTH_ISSUER_URL');
  const oauthIssuerUrl =
    oauthIssuerRaw !== undefined ? validateOAuthIssuerUrl(oauthIssuerRaw) : undefined;
  return {
    port: Number.isFinite(port) && port > 0 ? port : 3000,
    databaseUrl: readString(env, 'DATABASE_URL'),
    mcpBearerToken: readString(env, 'MCP_BEARER_TOKEN'),
    collectorToken: readString(env, 'COLLECTOR_TOKEN'),
    cacheFulltext: readString(env, 'CACHE_FULLTEXT') === 'true',
    collectorContact: readString(env, 'COLLECTOR_CONTACT'),
    trustEgressProxy,
    cookieSecure,
    oauthIssuerUrl,
    setupToken: readString(env, 'SETUP_TOKEN'),
    nodeEnv,
  };
}

/** 連絡先つき User-Agent 文字列(設計書 §5)。 */
export function buildUserAgent(contact: string | undefined): string {
  return contact ? `personal-rss-reader/0.1 (+${contact})` : 'personal-rss-reader/0.1';
}
