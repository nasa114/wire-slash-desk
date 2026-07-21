/** フィード(情報源)。fulltextAllowed は規約確認に基づく手動設定のみ(設計書 §6)。 */
export interface Feed {
  id: string;
  name: string;
  feedUrl: string;
  siteUrl: string | null;
  fetchIntervalMinutes: number;
  translate: boolean;
  fulltextAllowed: boolean;
  enabled: boolean;
  tosNote: string | null;
  /** 配信元の分類(例: 技術 / ニュース)。未分類は null。 */
  category: string | null;
  etag: string | null;
  lastModified: string | null;
  lastFetchedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewFeed {
  name: string;
  feedUrl: string;
  siteUrl?: string | null;
  fetchIntervalMinutes?: number;
  translate?: boolean;
  fulltextAllowed?: boolean;
  enabled?: boolean;
  tosNote?: string | null;
  category?: string | null;
}

export type FeedPatch = Partial<NewFeed>;

export interface Article {
  id: string;
  feedId: string;
  guid: string;
  title: string;
  url: string;
  publishedAt: Date | null;
  lang: string | null;
  /** 収集時は常に null。許可ソースへの明示操作でのみ非 null になり得る(設計書 §5 不変条件)。 */
  content: string | null;
  fetchedAt: Date;
}

/**
 * 収集時に保存できるフィールド。content を意図的に持たない —
 * collector が本文を書き込めないことを型レベルでも保証する(設計書 §5)。
 */
export interface NewArticle {
  feedId: string;
  guid: string;
  title: string;
  url: string;
  publishedAt?: Date | null;
  lang?: string | null;
}

/** 管理UIのログインユーザー(T4-1)。passwordHash は scrypt 形式文字列のみ。 */
export interface User {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewUser {
  username: string;
  passwordHash: string;
}

/** ブラウザセッション。tokenHash はトークンの sha256 hex(原文は保存しない)。 */
export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface NewSession {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

/**
 * MCP OAuth 2.1 の動的登録クライアント(T4-2、設計書 §7 Phase B)。
 * clientInfo は RFC 7591 のクライアントメタデータ一式(redirect_uris,
 * token_endpoint_auth_method 等)を JSON のまま保持する — SDK の
 * OAuthClientInformationFull と同形で、スキーマ検証は SDK 側が担う。
 */
export interface OAuthClient {
  clientId: string;
  clientInfo: Record<string, unknown>;
  createdAt: Date;
}

export interface NewOAuthClient {
  clientId: string;
  clientInfo: Record<string, unknown>;
}

/** 認可コード(one-time)。codeHash はコード原文の sha256 hex(原文は保存しない)。 */
export interface OAuthCode {
  codeHash: string;
  clientId: string;
  userId: string;
  /** PKCE S256 の code_challenge。トークン交換時の検証に使う。 */
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  expiresAt: Date;
  createdAt: Date;
}

export interface NewOAuthCode {
  codeHash: string;
  clientId: string;
  userId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  expiresAt: Date;
}

/**
 * アクセストークン+リフレッシュトークンの組(1レコード=1グラント)。
 * どちらも sha256 hex のみ保存(sessions と同方針 — DB 漏洩でトークンを偽造させない)。
 */
export interface OAuthToken {
  id: string;
  clientId: string;
  userId: string;
  scopes: string[];
  accessTokenHash: string;
  accessExpiresAt: Date;
  refreshTokenHash: string;
  refreshExpiresAt: Date;
  createdAt: Date;
}

export interface NewOAuthToken {
  clientId: string;
  userId: string;
  scopes: string[];
  accessTokenHash: string;
  accessExpiresAt: Date;
  refreshTokenHash: string;
  refreshExpiresAt: Date;
}

/**
 * 為替レートのキャッシュスナップショット(設計書 §14、T4-3)。
 * pair は 'USDJPY' 形式([A-Z]{6})。fetchedAt が TTL 判定の基準。
 */
export interface ExchangeRate {
  pair: string;
  rate: number;
  prevClose: number | null;
  marketTime: Date | null;
  fetchedAt: Date;
}
