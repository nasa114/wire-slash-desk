import type {
  Article,
  ExchangeRate,
  Feed,
  FeedPatch,
  NewArticle,
  NewFeed,
  NewOAuthClient,
  NewOAuthCode,
  NewOAuthToken,
  NewSession,
  NewUser,
  OAuthClient,
  OAuthCode,
  OAuthToken,
  Session,
  User,
} from './types.ts';

/** リポジトリ実装(memory / pg)を差し替えるための共通インターフェース(設計書 §3, D6)。 */
export interface FeedRepository {
  /** feedUrl 重複は DuplicateFeedUrlError、fetchIntervalMinutes < 15 は ValidationError。 */
  create(input: NewFeed): Promise<Feed>;
  getById(id: string): Promise<Feed | null>;
  getByFeedUrl(feedUrl: string): Promise<Feed | null>;
  list(): Promise<Feed[]>;
  /** enabled かつ (未取得 or lastFetchedAt + interval <= now) のフィード(設計書 §5-1)。 */
  listDue(now: Date): Promise<Feed[]>;
  /** 存在しない id は NotFoundError。 */
  update(id: string, patch: FeedPatch): Promise<Feed>;
  /** 取得完了の記録。304 時は meta 省略で lastFetchedAt のみ更新。 */
  markFetched(
    id: string,
    fetchedAt: Date,
    meta?: { etag?: string | null; lastModified?: string | null },
  ): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ListRecentOptions {
  since?: Date;
  feedId?: string;
  /** 既定 50、上限 200(設計書 §7)。 */
  limit?: number;
}

export interface UpsertResult {
  inserted: number;
  skipped: number;
}

export interface SearchOptions {
  /** 既定 50、上限 200(listRecent と同じクランプ)。 */
  limit?: number;
  /** 指定時はそのフィード内のみ検索。 */
  feedId?: string;
}

export interface ArticleRepository {
  /** (feedId, guid) 重複は上書きせずスキップ(設計書 §5-4)。未知の feedId は NotFoundError。 */
  upsertMany(items: NewArticle[]): Promise<UpsertResult>;
  getById(id: string): Promise<Article | null>;
  listRecent(options?: ListRecentOptions): Promise<Article[]>;
  searchByTitle(query: string, options?: SearchOptions): Promise<Article[]>;
  /** date は 'YYYY-MM-DD'(UTC 日付で publishedAt を照合)。 */
  listByDate(date: string): Promise<Article[]>;
  /** fulltext_allowed ソースの明示操作でのみ呼ぶこと。存在しない id は NotFoundError。 */
  setContent(id: string, content: string): Promise<void>;
}

/** 管理UIログイン用ユーザー(T4-1)。 */
export interface UserRepository {
  /** username 重複は DuplicateUsernameError。 */
  create(input: NewUser): Promise<User>;
  /**
   * 初回セットアップ専用の原子的作成(PT-001 対策)。
   * users が空のときだけ作成して User を返し、既に1件でも存在すれば作成せず null。
   * count() → create() の TOCTOU をなくし、並行 first-run でも1件しか作らせない。
   */
  createInitial(input: NewUser): Promise<User | null>;
  getById(id: string): Promise<User | null>;
  getByUsername(username: string): Promise<User | null>;
  /** 初回セットアップ(/setup)の開放判定に使う。 */
  count(): Promise<number>;
}

/** ブラウザセッション。トークン原文は扱わず sha256 ハッシュのみ受け取る。 */
export interface SessionRepository {
  create(input: NewSession): Promise<Session>;
  getByTokenHash(tokenHash: string): Promise<Session | null>;
  /** 存在しなくてもエラーにしない(ログアウトの二重実行を許容)。 */
  deleteByTokenHash(tokenHash: string): Promise<void>;
  /** expiresAt <= now のセッションを削除し、削除件数を返す。 */
  deleteExpired(now: Date): Promise<number>;
}

/** MCP OAuth 2.1 の動的登録クライアント(T4-2)。 */
export interface OAuthClientRepository {
  /** clientId 重複は DuplicateOAuthClientError(DCR は常にサーバー生成 UUID のため通常起きない)。 */
  create(input: NewOAuthClient): Promise<OAuthClient>;
  getById(clientId: string): Promise<OAuthClient | null>;
  /** DCR が無認証のため、資源枯渇対策の登録上限チェックに使う。 */
  count(): Promise<number>;
  /**
   * PT-002 対策: createdAt < cutoff かつ一度もトークンを発行していない
   * (oauth_tokens から参照されていない)クライアントを削除し、削除件数を返す。
   * 無認証 DCR による登録枠の永続的枯渇を、未使用登録の自動回収で緩和する。
   * 正規クライアントは初回フローでトークンを得るため対象にならない。
   */
  deleteUnusedBefore(cutoff: Date): Promise<number>;
  /**
   * PT-002 対策(低レート再登録によるバイパス封じ): 未使用(トークン未発行)の
   * クライアントのうち最古の1件だけを削除し、削除できたら true を返す。
   * 登録枠が満杯でも、この「未使用の追い出し」により正規クライアントの新規登録を
   * 常に通す(使用中=トークン発行済みクライアントは決して追い出さない)。
   * 追い出せる未使用クライアントが1件も無い(全て使用中)場合のみ false。
   */
  deleteOldestUnused(): Promise<boolean>;
}

/** 認可コード(one-time)。 */
export interface OAuthCodeRepository {
  /** 存在しない clientId / userId は NotFoundError。 */
  create(input: NewOAuthCode): Promise<OAuthCode>;
  /** PKCE チャレンジ参照用(消費しない)。 */
  getByCodeHash(codeHash: string): Promise<OAuthCode | null>;
  /** 取得と同時に削除し one-time use を原子的に保証する。無ければ null。 */
  consumeByCodeHash(codeHash: string): Promise<OAuthCode | null>;
  deleteExpired(now: Date): Promise<number>;
}

/** アクセス/リフレッシュトークン。 */
export interface OAuthTokenRepository {
  /** 存在しない clientId / userId は NotFoundError。 */
  create(input: NewOAuthToken): Promise<OAuthToken>;
  getByAccessTokenHash(hash: string): Promise<OAuthToken | null>;
  getByRefreshTokenHash(hash: string): Promise<OAuthToken | null>;
  /**
   * refresh ハッシュ一致のレコードを取得と同時に削除する(ローテーションの原子化)。
   * 並行リフレッシュや盗難トークンの再利用で二重発行しないための one-time 保証。
   */
  consumeByRefreshTokenHash(hash: string): Promise<OAuthToken | null>;
  /** リフレッシュローテーション用。存在しなくてもエラーにしない。 */
  deleteById(id: string): Promise<void>;
  /** RFC 7009 失効: access / refresh どちらのハッシュ一致でもレコードごと削除。 */
  deleteByAnyTokenHash(hash: string): Promise<void>;
  /** refreshExpiresAt <= now のレコードを削除(refresh が生きている限り残す)。 */
  deleteExpired(now: Date): Promise<number>;
}

/**
 * 為替レートキャッシュ(設計書 §14、T4-3)。pair 主キーで最新1行のみ保持する。
 * TTL 判定はサービス層(src/rates/service.ts)の責務で、リポジトリは保存と取得のみ。
 */
export interface ExchangeRateRepository {
  get(pair: string): Promise<ExchangeRate | null>;
  /** pair が存在すれば全列更新、無ければ挿入する。 */
  upsert(input: ExchangeRate): Promise<void>;
}

export interface Repositories {
  feeds: FeedRepository;
  articles: ArticleRepository;
  exchangeRates: ExchangeRateRepository;
  users: UserRepository;
  sessions: SessionRepository;
  oauthClients: OAuthClientRepository;
  oauthCodes: OAuthCodeRepository;
  oauthTokens: OAuthTokenRepository;
  close(): Promise<void>;
}
