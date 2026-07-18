import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Repositories } from '../../src/domain/repositories.ts';
import type { NewOAuthCode, NewOAuthToken, User } from '../../src/domain/types.ts';
import { DuplicateOAuthClientError, NotFoundError } from '../../src/domain/errors.ts';

export type MakeRepos = () => Promise<Repositories>;

const HOUR = 60 * 60_000;

async function makeUser(repos: Repositories, username = 'oauth-owner'): Promise<User> {
  return repos.users.create({ username, passwordHash: 'h' });
}

async function makeClient(repos: Repositories, clientId = 'client-1'): Promise<void> {
  await repos.oauthClients.create({
    clientId,
    clientInfo: { redirect_uris: ['https://example.com/cb'], token_endpoint_auth_method: 'none' },
  });
}

function newCode(clientId: string, userId: string, overrides: Partial<NewOAuthCode> = {}): NewOAuthCode {
  return {
    codeHash: 'ch1',
    clientId,
    userId,
    codeChallenge: 'challenge',
    redirectUri: 'https://example.com/cb',
    scopes: ['mcp'],
    expiresAt: new Date(Date.now() + HOUR),
    ...overrides,
  };
}

function newToken(clientId: string, userId: string, overrides: Partial<NewOAuthToken> = {}): NewOAuthToken {
  return {
    clientId,
    userId,
    scopes: ['mcp'],
    accessTokenHash: 'ath1',
    accessExpiresAt: new Date(Date.now() + HOUR),
    refreshTokenHash: 'rth1',
    refreshExpiresAt: new Date(Date.now() + 24 * HOUR),
    ...overrides,
  };
}

/**
 * OAuth(clients / codes / tokens)リポジトリ契約テスト。
 * memory / pg どちらの実装もこのスイートを通過すること(T4-2)。
 */
export function runOAuthRepositoriesContract(impl: string, makeRepos: MakeRepos): void {
  const t = (name: string) => `[${impl}] OAuthRepositories: ${name}`;

  test(t('clients: create / getById / count の往復'), async () => {
    const repos = await makeRepos();
    try {
      assert.equal(await repos.oauthClients.count(), 0);
      const created = await repos.oauthClients.create({
        clientId: 'c1',
        clientInfo: { redirect_uris: ['https://example.com/cb'], client_name: 'Test' },
      });
      assert.equal(created.clientId, 'c1');
      assert.deepEqual(created.clientInfo, {
        redirect_uris: ['https://example.com/cb'],
        client_name: 'Test',
      });
      assert.ok(created.createdAt instanceof Date);
      const found = await repos.oauthClients.getById('c1');
      assert.equal(found?.clientId, 'c1');
      assert.deepEqual(found?.clientInfo, created.clientInfo);
      assert.equal(await repos.oauthClients.getById('unknown'), null);
      assert.equal(await repos.oauthClients.count(), 1);
    } finally {
      await repos.close();
    }
  });

  test(t('clients: clientId 重複は DuplicateOAuthClientError'), async () => {
    const repos = await makeRepos();
    try {
      await makeClient(repos, 'dup');
      await assert.rejects(
        repos.oauthClients.create({ clientId: 'dup', clientInfo: {} }),
        DuplicateOAuthClientError,
      );
    } finally {
      await repos.close();
    }
  });

  test(t('codes: create / getByCodeHash / consumeByCodeHash(one-time)'), async () => {
    const repos = await makeRepos();
    try {
      const user = await makeUser(repos);
      await makeClient(repos);
      const created = await repos.oauthCodes.create(newCode('client-1', user.id));
      assert.equal(created.codeHash, 'ch1');
      assert.deepEqual(created.scopes, ['mcp']);

      // getByCodeHash は消費しない(PKCE チャレンジ参照用)。
      const peeked = await repos.oauthCodes.getByCodeHash('ch1');
      assert.equal(peeked?.codeChallenge, 'challenge');
      assert.equal(peeked?.redirectUri, 'https://example.com/cb');
      assert.notEqual(await repos.oauthCodes.getByCodeHash('ch1'), null);

      // consume は一度きり。二度目は null。
      const consumed = await repos.oauthCodes.consumeByCodeHash('ch1');
      assert.equal(consumed?.clientId, 'client-1');
      assert.equal(consumed?.userId, user.id);
      assert.equal(await repos.oauthCodes.consumeByCodeHash('ch1'), null);
      assert.equal(await repos.oauthCodes.getByCodeHash('ch1'), null);
    } finally {
      await repos.close();
    }
  });

  test(t('codes: 存在しない clientId / userId は NotFoundError'), async () => {
    const repos = await makeRepos();
    try {
      const user = await makeUser(repos);
      await makeClient(repos);
      await assert.rejects(
        repos.oauthCodes.create(newCode('missing-client', user.id)),
        NotFoundError,
      );
      await assert.rejects(
        repos.oauthCodes.create(
          newCode('client-1', '00000000-0000-0000-0000-000000000000'),
        ),
        NotFoundError,
      );
    } finally {
      await repos.close();
    }
  });

  test(t('codes: deleteExpired は期限切れのみ削除し件数を返す'), async () => {
    const repos = await makeRepos();
    try {
      const user = await makeUser(repos);
      await makeClient(repos);
      const now = new Date();
      await repos.oauthCodes.create(
        newCode('client-1', user.id, { codeHash: 'expired', expiresAt: new Date(now.getTime() - 1) }),
      );
      await repos.oauthCodes.create(
        newCode('client-1', user.id, { codeHash: 'alive', expiresAt: new Date(now.getTime() + HOUR) }),
      );
      assert.equal(await repos.oauthCodes.deleteExpired(now), 1);
      assert.equal(await repos.oauthCodes.getByCodeHash('expired'), null);
      assert.notEqual(await repos.oauthCodes.getByCodeHash('alive'), null);
    } finally {
      await repos.close();
    }
  });

  test(t('tokens: create / access・refresh ハッシュでの取得'), async () => {
    const repos = await makeRepos();
    try {
      const user = await makeUser(repos);
      await makeClient(repos);
      const created = await repos.oauthTokens.create(newToken('client-1', user.id));
      assert.ok(created.id.length > 0);
      assert.deepEqual(created.scopes, ['mcp']);
      const byAccess = await repos.oauthTokens.getByAccessTokenHash('ath1');
      assert.equal(byAccess?.id, created.id);
      const byRefresh = await repos.oauthTokens.getByRefreshTokenHash('rth1');
      assert.equal(byRefresh?.id, created.id);
      // access ハッシュを refresh 側で引いてもヒットしない(用途の混同を防ぐ)。
      assert.equal(await repos.oauthTokens.getByRefreshTokenHash('ath1'), null);
      assert.equal(await repos.oauthTokens.getByAccessTokenHash('rth1'), null);
      assert.equal(await repos.oauthTokens.getByAccessTokenHash('unknown'), null);
    } finally {
      await repos.close();
    }
  });

  test(t('tokens: 存在しない clientId / userId は NotFoundError'), async () => {
    const repos = await makeRepos();
    try {
      const user = await makeUser(repos);
      await makeClient(repos);
      await assert.rejects(
        repos.oauthTokens.create(newToken('missing-client', user.id)),
        NotFoundError,
      );
      await assert.rejects(
        repos.oauthTokens.create(
          newToken('client-1', '00000000-0000-0000-0000-000000000000'),
        ),
        NotFoundError,
      );
    } finally {
      await repos.close();
    }
  });

  test(t('tokens: deleteById / deleteByAnyTokenHash は冪等'), async () => {
    const repos = await makeRepos();
    try {
      const user = await makeUser(repos);
      await makeClient(repos);
      const a = await repos.oauthTokens.create(
        newToken('client-1', user.id, { accessTokenHash: 'a1', refreshTokenHash: 'r1' }),
      );
      await repos.oauthTokens.create(
        newToken('client-1', user.id, { accessTokenHash: 'a2', refreshTokenHash: 'r2' }),
      );
      await repos.oauthTokens.deleteById(a.id);
      assert.equal(await repos.oauthTokens.getByAccessTokenHash('a1'), null);
      await repos.oauthTokens.deleteById(a.id); // 二重削除もエラーにしない

      // access ハッシュでも refresh ハッシュでもレコードごと消える。
      await repos.oauthTokens.deleteByAnyTokenHash('a2');
      assert.equal(await repos.oauthTokens.getByRefreshTokenHash('r2'), null);
      await repos.oauthTokens.deleteByAnyTokenHash('a2'); // 冪等
      const b = await repos.oauthTokens.create(
        newToken('client-1', user.id, { accessTokenHash: 'a3', refreshTokenHash: 'r3' }),
      );
      await repos.oauthTokens.deleteByAnyTokenHash('r3');
      assert.equal(await repos.oauthTokens.getByAccessTokenHash('a3'), null);
      assert.ok(b.id.length > 0);
    } finally {
      await repos.close();
    }
  });

  test(t('tokens: consumeByRefreshTokenHash は一度きり(原子的ローテーション)'), async () => {
    const repos = await makeRepos();
    try {
      const user = await makeUser(repos);
      await makeClient(repos);
      await repos.oauthTokens.create(
        newToken('client-1', user.id, { accessTokenHash: 'ac', refreshTokenHash: 'rc' }),
      );
      const consumed = await repos.oauthTokens.consumeByRefreshTokenHash('rc');
      assert.equal(consumed?.clientId, 'client-1');
      // 消費済み: 再取得も再消費も null、access 側でも引けない。
      assert.equal(await repos.oauthTokens.consumeByRefreshTokenHash('rc'), null);
      assert.equal(await repos.oauthTokens.getByRefreshTokenHash('rc'), null);
      assert.equal(await repos.oauthTokens.getByAccessTokenHash('ac'), null);
      // access ハッシュでは consume できない。
      await repos.oauthTokens.create(
        newToken('client-1', user.id, { accessTokenHash: 'ac2', refreshTokenHash: 'rc2' }),
      );
      assert.equal(await repos.oauthTokens.consumeByRefreshTokenHash('ac2'), null);
    } finally {
      await repos.close();
    }
  });

  test(t('tokens: deleteExpired は refresh 期限切れのみ削除する'), async () => {
    const repos = await makeRepos();
    try {
      const user = await makeUser(repos);
      await makeClient(repos);
      const now = new Date();
      // access は切れているが refresh は生きている → 残す(リフレッシュ可能)。
      await repos.oauthTokens.create(
        newToken('client-1', user.id, {
          accessTokenHash: 'a-old',
          refreshTokenHash: 'r-alive',
          accessExpiresAt: new Date(now.getTime() - 1),
          refreshExpiresAt: new Date(now.getTime() + HOUR),
        }),
      );
      // refresh まで切れている → 削除。
      await repos.oauthTokens.create(
        newToken('client-1', user.id, {
          accessTokenHash: 'a-dead',
          refreshTokenHash: 'r-dead',
          accessExpiresAt: new Date(now.getTime() - 2),
          refreshExpiresAt: new Date(now.getTime() - 1),
        }),
      );
      assert.equal(await repos.oauthTokens.deleteExpired(now), 1);
      assert.notEqual(await repos.oauthTokens.getByRefreshTokenHash('r-alive'), null);
      assert.equal(await repos.oauthTokens.getByRefreshTokenHash('r-dead'), null);
    } finally {
      await repos.close();
    }
  });

  test(t('同一ユーザー・同一クライアントで複数グラントが共存できる'), async () => {
    const repos = await makeRepos();
    try {
      const user = await makeUser(repos);
      await makeClient(repos);
      await repos.oauthCodes.create(newCode('client-1', user.id));
      await repos.oauthTokens.create(newToken('client-1', user.id));
      await repos.oauthTokens.create(
        newToken('client-1', user.id, { accessTokenHash: 'a2nd', refreshTokenHash: 'r2nd' }),
      );
      assert.notEqual(await repos.oauthTokens.getByAccessTokenHash('a2nd'), null);
      assert.notEqual(await repos.oauthTokens.getByAccessTokenHash('ath1'), null);
    } finally {
      await repos.close();
    }
  });
}
