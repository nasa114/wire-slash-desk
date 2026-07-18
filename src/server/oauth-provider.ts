import { createHash, randomBytes } from 'node:crypto';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Repositories } from '../domain/repositories.ts';

/**
 * MCP OAuth 2.1 認可サーバー(T4-2、設計書 §7 Phase B・U5=アプリ内蔵)。
 * プロトコル面(PKCE 検証・パラメータ検証・DCR)は SDK の公式ハンドラが担い、
 * 本クラスは「発行と保存」だけをリポジトリ層に橋渡しする。
 *
 * トークン・認可コードはランダム 32 バイト(base64url)を発行し、DB には
 * sha256 ハッシュのみ保存する(sessions と同方針)。
 */

/** アクセストークン有効期間: 1時間。 */
export const OAUTH_ACCESS_TTL_MS = 60 * 60_000;
/** リフレッシュトークン有効期間: 30日(ローテーションで更新)。 */
export const OAUTH_REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
/** 認可コード有効期間: 5分(RFC 6749 §4.1.2 の最大 10 分推奨内)。 */
export const OAUTH_CODE_TTL_MS = 5 * 60_000;
/** 同意待ち認可リクエストの有効期間: 10分。 */
const PENDING_TTL_MS = 10 * 60_000;
/** 同意待ちの同時保持上限(悪意ある大量 /authorize でのメモリ枯渇対策)。 */
const MAX_PENDING = 100;
/** DCR で登録できるクライアント総数の上限(無認証登録の資源枯渇対策)。 */
const MAX_CLIENTS = 100;

/** 付与するスコープは単一固定。要求スコープは無視して常にこれを与える。 */
export const OAUTH_SCOPES = ['mcp'];

/**
 * express.Response のうち authorize() が使う最小面。
 * @types/express を devDependency に増やさないための構造的型
 * (SDK の型定義は skipLibCheck 配下なので express 型が無くても検査を通る)。
 */
interface AuthorizeResponse {
  status(code: number): { json(body: unknown): void };
  redirect(status: number, url: string): void;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function generateSecret(): { secret: string; hash: string } {
  const secret = randomBytes(32).toString('base64url');
  return { secret, hash: sha256Hex(secret) };
}

/** /authorize から同意画面へ引き継ぐ、検証済み認可リクエスト。 */
export interface PendingAuthorization {
  id: string;
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
}

export interface OAuthProviderDeps {
  repos: Repositories;
  now?: () => Date;
}

export class RssOAuthProvider implements OAuthServerProvider {
  private readonly repos: Repositories;
  private readonly now: () => Date;
  private readonly pending = new Map<string, PendingAuthorization>();

  constructor(deps: OAuthProviderDeps) {
    this.repos = deps.repos;
    this.now = deps.now ?? (() => new Date());
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const repos = this.repos;
    return {
      async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
        const client = await repos.oauthClients.getById(clientId);
        if (client === null) return undefined;
        return client.clientInfo as unknown as OAuthClientInformationFull;
      },
      async registerClient(
        client: OAuthClientInformationFull,
      ): Promise<OAuthClientInformationFull> {
        if ((await repos.oauthClients.count()) >= MAX_CLIENTS) {
          throw new InvalidClientMetadataError('client registry is full');
        }
        await repos.oauthClients.create({
          clientId: client.client_id,
          clientInfo: client as unknown as Record<string, unknown>,
        });
        return client;
      },
    };
  }

  /**
   * SDK の /authorize ハンドラがパラメータ検証済みで呼ぶ。ここではリクエストを
   * 同意待ちとして保持し、ログインセッション必須の同意画面へリダイレクトする。
   * ユーザー同意なしにコードを発行しない(認可の主体は Web UI ログインユーザー)。
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: AuthorizeResponse,
  ): Promise<void> {
    this.prunePending();
    if (this.pending.size >= MAX_PENDING) {
      // 直接応答(リダイレクト前エラーと同じ扱い)。理由は書きすぎない。
      res.status(503).json({ error: 'temporarily_unavailable' });
      return;
    }
    const id = randomBytes(16).toString('base64url');
    this.pending.set(id, {
      id,
      client,
      params,
      expiresAt: this.now().getTime() + PENDING_TTL_MS,
    });
    res.redirect(302, `/oauth/consent?request=${id}`);
  }

  /** 同意画面の表示用(消費しない)。期限切れ・不明 id は null。 */
  peekPendingAuthorization(id: string): PendingAuthorization | null {
    this.prunePending();
    return this.pending.get(id) ?? null;
  }

  /**
   * 同意画面の POST(承認/拒否)から呼ぶ。pending を消費し、リダイレクト先 URL を返す。
   * 承認時は認可コードを発行して保存する。
   */
  async completeAuthorization(
    id: string,
    userId: string,
    approved: boolean,
  ): Promise<{ redirectTo: string } | null> {
    this.prunePending();
    const entry = this.pending.get(id);
    if (entry === undefined) return null;
    this.pending.delete(id);

    const redirect = new URL(entry.params.redirectUri);
    if (!approved) {
      redirect.searchParams.set('error', 'access_denied');
      if (entry.params.state !== undefined) redirect.searchParams.set('state', entry.params.state);
      return { redirectTo: redirect.href };
    }

    const { secret: code, hash: codeHash } = generateSecret();
    await this.repos.oauthCodes.deleteExpired(this.now());
    await this.repos.oauthCodes.create({
      codeHash,
      clientId: entry.client.client_id,
      userId,
      codeChallenge: entry.params.codeChallenge,
      redirectUri: entry.params.redirectUri,
      scopes: OAUTH_SCOPES,
      expiresAt: new Date(this.now().getTime() + OAUTH_CODE_TTL_MS),
    });
    redirect.searchParams.set('code', code);
    if (entry.params.state !== undefined) redirect.searchParams.set('state', entry.params.state);
    return { redirectTo: redirect.href };
  }

  /** SDK の /token ハンドラが PKCE 検証のために呼ぶ(コードは消費しない)。 */
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const code = await this.repos.oauthCodes.getByCodeHash(sha256Hex(authorizationCode));
    if (code === null || code.clientId !== client.client_id) {
      throw new InvalidGrantError('invalid authorization code');
    }
    if (code.expiresAt.getTime() <= this.now().getTime()) {
      throw new InvalidGrantError('authorization code expired');
    }
    return code.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    // consume は原子的(一度きり)。盗まれたコードとの競合でも二重発行しない。
    const code = await this.repos.oauthCodes.consumeByCodeHash(sha256Hex(authorizationCode));
    if (code === null || code.clientId !== client.client_id) {
      throw new InvalidGrantError('invalid authorization code');
    }
    if (code.expiresAt.getTime() <= this.now().getTime()) {
      throw new InvalidGrantError('authorization code expired');
    }
    // RFC 6749 §4.1.3: 交換時の redirect_uri は認可時と一致しなければならない。
    if (redirectUri !== undefined && redirectUri !== code.redirectUri) {
      throw new InvalidGrantError('redirect_uri mismatch');
    }
    return this.issueTokens(code.clientId, code.userId, code.scopes);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    await this.repos.oauthTokens.deleteExpired(this.now());
    // 原子的 consume でローテーション: 並行リフレッシュは片方しか成功しない。
    // クライアント不一致・期限切れでも旧グラントは破棄されたまま(fail-closed —
    // 正当な refresh token を不正な文脈で提示された時点でそのグラントを失効させる)。
    const record = await this.repos.oauthTokens.consumeByRefreshTokenHash(sha256Hex(refreshToken));
    if (record === null || record.clientId !== client.client_id) {
      throw new InvalidGrantError('invalid refresh token');
    }
    if (record.refreshExpiresAt.getTime() <= this.now().getTime()) {
      throw new InvalidGrantError('refresh token expired');
    }
    if (scopes !== undefined && scopes.some((s) => !record.scopes.includes(s))) {
      throw new InvalidScopeError('requested scope exceeds granted scope');
    }
    return this.issueTokens(record.clientId, record.userId, record.scopes);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = await this.repos.oauthTokens.getByAccessTokenHash(sha256Hex(token));
    if (record === null) throw new InvalidTokenError('invalid access token');
    if (record.accessExpiresAt.getTime() <= this.now().getTime()) {
      throw new InvalidTokenError('access token expired');
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.accessExpiresAt.getTime() / 1000),
      extra: { userId: record.userId },
    };
  }

  /** RFC 7009: 不明・他クライアントのトークンでもエラーにしない(情報を漏らさない)。 */
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const hash = sha256Hex(request.token);
    const record =
      (await this.repos.oauthTokens.getByAccessTokenHash(hash)) ??
      (await this.repos.oauthTokens.getByRefreshTokenHash(hash));
    if (record === null || record.clientId !== client.client_id) return;
    await this.repos.oauthTokens.deleteById(record.id);
  }

  private async issueTokens(
    clientId: string,
    userId: string,
    scopes: string[],
  ): Promise<OAuthTokens> {
    const access = generateSecret();
    const refresh = generateSecret();
    const now = this.now().getTime();
    await this.repos.oauthTokens.create({
      clientId,
      userId,
      scopes,
      accessTokenHash: access.hash,
      accessExpiresAt: new Date(now + OAUTH_ACCESS_TTL_MS),
      refreshTokenHash: refresh.hash,
      refreshExpiresAt: new Date(now + OAUTH_REFRESH_TTL_MS),
    });
    return {
      access_token: access.secret,
      token_type: 'bearer',
      expires_in: Math.floor(OAUTH_ACCESS_TTL_MS / 1000),
      refresh_token: refresh.secret,
      scope: scopes.join(' '),
    };
  }

  private prunePending(): void {
    const now = this.now().getTime();
    for (const [id, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(id);
    }
  }
}
