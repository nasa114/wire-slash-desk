import type {
  Article,
  Feed,
  OAuthClient,
  OAuthCode,
  OAuthToken,
  Session,
  User,
} from '../../domain/types.ts';

/** feeds テーブルの行(snake_case)。pg ドライバは timestamptz/uuid/int/bool を適切な JS 型へ変換済み。 */
export interface FeedRow {
  id: string;
  name: string;
  feed_url: string;
  site_url: string | null;
  fetch_interval_minutes: number;
  translate: boolean;
  fulltext_allowed: boolean;
  enabled: boolean;
  tos_note: string | null;
  category: string | null;
  etag: string | null;
  last_modified: string | null;
  last_fetched_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function mapFeedRow(row: FeedRow): Feed {
  return {
    id: row.id,
    name: row.name,
    feedUrl: row.feed_url,
    siteUrl: row.site_url,
    fetchIntervalMinutes: row.fetch_interval_minutes,
    translate: row.translate,
    fulltextAllowed: row.fulltext_allowed,
    enabled: row.enabled,
    tosNote: row.tos_note,
    category: row.category,
    etag: row.etag,
    lastModified: row.last_modified,
    lastFetchedAt: row.last_fetched_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** articles テーブルの行(snake_case)。 */
export interface ArticleRow {
  id: string;
  feed_id: string;
  guid: string;
  title: string;
  url: string;
  published_at: Date | null;
  lang: string | null;
  content: string | null;
  fetched_at: Date;
}

export function mapArticleRow(row: ArticleRow): Article {
  return {
    id: row.id,
    feedId: row.feed_id,
    guid: row.guid,
    title: row.title,
    url: row.url,
    publishedAt: row.published_at,
    lang: row.lang,
    content: row.content,
    fetchedAt: row.fetched_at,
  };
}

/** users テーブルの行(snake_case)。 */
export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
}

export function mapUserRow(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** sessions テーブルの行(snake_case)。 */
export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  created_at: Date;
}

export function mapSessionRow(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

/** oauth_clients テーブルの行。client_info は jsonb(pg が JS オブジェクトに復元)。 */
export interface OAuthClientRow {
  client_id: string;
  client_info: Record<string, unknown>;
  created_at: Date;
}

export function mapOAuthClientRow(row: OAuthClientRow): OAuthClient {
  return {
    clientId: row.client_id,
    clientInfo: row.client_info,
    createdAt: row.created_at,
  };
}

/** oauth_codes テーブルの行。 */
export interface OAuthCodeRow {
  code_hash: string;
  client_id: string;
  user_id: string;
  code_challenge: string;
  redirect_uri: string;
  scopes: string[];
  expires_at: Date;
  created_at: Date;
}

export function mapOAuthCodeRow(row: OAuthCodeRow): OAuthCode {
  return {
    codeHash: row.code_hash,
    clientId: row.client_id,
    userId: row.user_id,
    codeChallenge: row.code_challenge,
    redirectUri: row.redirect_uri,
    scopes: row.scopes,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

/** oauth_tokens テーブルの行。 */
export interface OAuthTokenRow {
  id: string;
  client_id: string;
  user_id: string;
  scopes: string[];
  access_token_hash: string;
  access_expires_at: Date;
  refresh_token_hash: string;
  refresh_expires_at: Date;
  created_at: Date;
}

export function mapOAuthTokenRow(row: OAuthTokenRow): OAuthToken {
  return {
    id: row.id,
    clientId: row.client_id,
    userId: row.user_id,
    scopes: row.scopes,
    accessTokenHash: row.access_token_hash,
    accessExpiresAt: row.access_expires_at,
    refreshTokenHash: row.refresh_token_hash,
    refreshExpiresAt: row.refresh_expires_at,
    createdAt: row.created_at,
  };
}
