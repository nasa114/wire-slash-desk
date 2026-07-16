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
