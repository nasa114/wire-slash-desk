import { randomUUID } from 'node:crypto';
import type {
  NewOAuthClient,
  NewOAuthCode,
  NewOAuthToken,
  OAuthClient,
  OAuthCode,
  OAuthToken,
} from '../../domain/types.ts';
import type {
  OAuthClientRepository,
  OAuthCodeRepository,
  OAuthTokenRepository,
} from '../../domain/repositories.ts';
import { DuplicateOAuthClientError, NotFoundError } from '../../domain/errors.ts';
import {
  cloneOAuthClient,
  cloneOAuthCode,
  cloneOAuthToken,
  type MemoryStore,
} from './store.ts';

export class MemoryOAuthClientRepository implements OAuthClientRepository {
  private readonly store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  async create(input: NewOAuthClient): Promise<OAuthClient> {
    if (this.store.oauthClients.has(input.clientId)) {
      throw new DuplicateOAuthClientError(input.clientId);
    }
    const client: OAuthClient = {
      clientId: input.clientId,
      clientInfo: structuredClone(input.clientInfo),
      createdAt: new Date(),
    };
    this.store.oauthClients.set(client.clientId, client);
    return cloneOAuthClient(client);
  }

  async getById(clientId: string): Promise<OAuthClient | null> {
    const client = this.store.oauthClients.get(clientId);
    return client === undefined ? null : cloneOAuthClient(client);
  }

  async count(): Promise<number> {
    return this.store.oauthClients.size;
  }
}

export class MemoryOAuthCodeRepository implements OAuthCodeRepository {
  private readonly store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  async create(input: NewOAuthCode): Promise<OAuthCode> {
    if (!this.store.oauthClients.has(input.clientId)) {
      throw new NotFoundError('oauth client', input.clientId);
    }
    if (!this.store.users.has(input.userId)) throw new NotFoundError('user', input.userId);
    const code: OAuthCode = {
      codeHash: input.codeHash,
      clientId: input.clientId,
      userId: input.userId,
      codeChallenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      scopes: [...input.scopes],
      expiresAt: new Date(input.expiresAt),
      createdAt: new Date(),
    };
    this.store.oauthCodes.set(code.codeHash, code);
    return cloneOAuthCode(code);
  }

  async getByCodeHash(codeHash: string): Promise<OAuthCode | null> {
    const code = this.store.oauthCodes.get(codeHash);
    return code === undefined ? null : cloneOAuthCode(code);
  }

  async consumeByCodeHash(codeHash: string): Promise<OAuthCode | null> {
    const code = this.store.oauthCodes.get(codeHash);
    if (code === undefined) return null;
    this.store.oauthCodes.delete(codeHash);
    return cloneOAuthCode(code);
  }

  async deleteExpired(now: Date): Promise<number> {
    let deleted = 0;
    for (const [hash, code] of this.store.oauthCodes) {
      if (code.expiresAt.getTime() <= now.getTime()) {
        this.store.oauthCodes.delete(hash);
        deleted += 1;
      }
    }
    return deleted;
  }
}

export class MemoryOAuthTokenRepository implements OAuthTokenRepository {
  private readonly store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  async create(input: NewOAuthToken): Promise<OAuthToken> {
    if (!this.store.oauthClients.has(input.clientId)) {
      throw new NotFoundError('oauth client', input.clientId);
    }
    if (!this.store.users.has(input.userId)) throw new NotFoundError('user', input.userId);
    const token: OAuthToken = {
      id: randomUUID(),
      clientId: input.clientId,
      userId: input.userId,
      scopes: [...input.scopes],
      accessTokenHash: input.accessTokenHash,
      accessExpiresAt: new Date(input.accessExpiresAt),
      refreshTokenHash: input.refreshTokenHash,
      refreshExpiresAt: new Date(input.refreshExpiresAt),
      createdAt: new Date(),
    };
    this.store.oauthTokens.set(token.id, token);
    return cloneOAuthToken(token);
  }

  async getByAccessTokenHash(hash: string): Promise<OAuthToken | null> {
    for (const token of this.store.oauthTokens.values()) {
      if (token.accessTokenHash === hash) return cloneOAuthToken(token);
    }
    return null;
  }

  async getByRefreshTokenHash(hash: string): Promise<OAuthToken | null> {
    for (const token of this.store.oauthTokens.values()) {
      if (token.refreshTokenHash === hash) return cloneOAuthToken(token);
    }
    return null;
  }

  async consumeByRefreshTokenHash(hash: string): Promise<OAuthToken | null> {
    for (const [id, token] of this.store.oauthTokens) {
      if (token.refreshTokenHash === hash) {
        this.store.oauthTokens.delete(id);
        return cloneOAuthToken(token);
      }
    }
    return null;
  }

  async deleteById(id: string): Promise<void> {
    this.store.oauthTokens.delete(id);
  }

  async deleteByAnyTokenHash(hash: string): Promise<void> {
    for (const [id, token] of this.store.oauthTokens) {
      if (token.accessTokenHash === hash || token.refreshTokenHash === hash) {
        this.store.oauthTokens.delete(id);
        return;
      }
    }
  }

  async deleteExpired(now: Date): Promise<number> {
    let deleted = 0;
    for (const [id, token] of this.store.oauthTokens) {
      if (token.refreshExpiresAt.getTime() <= now.getTime()) {
        this.store.oauthTokens.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }
}
