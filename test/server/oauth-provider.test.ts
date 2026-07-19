import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createMemoryRepositories } from '../../src/repo/memory/index.ts';
import {
  OAUTH_ACCESS_TTL_MS,
  OAUTH_CODE_TTL_MS,
  RssOAuthProvider,
  sha256Hex,
} from '../../src/server/oauth-provider.ts';
import type { Repositories } from '../../src/domain/repositories.ts';

const CLIENT: OAuthClientInformationFull = {
  client_id: 'client-1',
  redirect_uris: ['https://example.com/cb'],
  token_endpoint_auth_method: 'none',
};

const OTHER_CLIENT: OAuthClientInformationFull = {
  client_id: 'client-2',
  redirect_uris: ['https://other.example/cb'],
  token_endpoint_auth_method: 'none',
};

interface Ctx {
  repos: Repositories;
  provider: RssOAuthProvider;
  userId: string;
  setNow: (d: Date) => void;
}

async function makeCtx(): Promise<Ctx> {
  const repos = createMemoryRepositories();
  let now = new Date('2026-07-18T00:00:00Z');
  const provider = new RssOAuthProvider({ repos, now: () => now });
  const user = await repos.users.create({ username: 'owner', passwordHash: 'h' });
  await Promise.resolve(provider.clientsStore.registerClient!(CLIENT));
  await Promise.resolve(provider.clientsStore.registerClient!(OTHER_CLIENT));
  return {
    repos,
    provider,
    userId: user.id,
    setNow: (d) => {
      now = d;
    },
  };
}

/** authorize → 同意承認まで進めて認可コード原文を取り出すヘルパー。 */
async function obtainCode(ctx: Ctx, state?: string): Promise<string> {
  let redirected = '';
  const res = {
    status: () => ({ json: () => {} }),
    redirect: (_status: number, url: string) => {
      redirected = url;
    },
  };
  await ctx.provider.authorize(
    CLIENT,
    {
      codeChallenge: 'challenge-abc',
      redirectUri: 'https://example.com/cb',
      ...(state !== undefined ? { state } : {}),
    },
    res,
  );
  const requestId = new URL(redirected, 'http://x').searchParams.get('request');
  assert.ok(requestId, 'authorize は同意画面へ request id つきでリダイレクトする');
  const result = await ctx.provider.completeAuthorization(requestId, ctx.userId, true);
  assert.ok(result);
  const url = new URL(result.redirectTo);
  assert.equal(url.origin + url.pathname, 'https://example.com/cb');
  const code = url.searchParams.get('code');
  assert.ok(code);
  return code;
}

test('authorize → 同意承認 → コード交換でトークンが発行される(state も往復)', async () => {
  const ctx = await makeCtx();
  const code = await obtainCode(ctx, 'st-1');

  // PKCE チャレンジはコードを消費せず参照できる。
  assert.equal(await ctx.provider.challengeForAuthorizationCode(CLIENT, code), 'challenge-abc');

  const tokens = await ctx.provider.exchangeAuthorizationCode(
    CLIENT,
    code,
    undefined,
    'https://example.com/cb',
  );
  assert.equal(tokens.token_type, 'bearer');
  assert.equal(tokens.scope, 'mcp');
  assert.equal(tokens.expires_in, OAUTH_ACCESS_TTL_MS / 1000);
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.notEqual(tokens.access_token, tokens.refresh_token);

  // DB にはハッシュのみ保存されている。
  const rec = await ctx.repos.oauthTokens.getByAccessTokenHash(sha256Hex(tokens.access_token));
  assert.ok(rec);
  assert.equal(rec.userId, ctx.userId);

  const info = await ctx.provider.verifyAccessToken(tokens.access_token);
  assert.equal(info.clientId, 'client-1');
  assert.deepEqual(info.scopes, ['mcp']);
  assert.equal(info.extra?.userId, ctx.userId);
});

test('同意拒否は access_denied でリダイレクトし、コードを発行しない', async () => {
  const ctx = await makeCtx();
  let redirected = '';
  const res = {
    status: () => ({ json: () => {} }),
    redirect: (_s: number, url: string) => {
      redirected = url;
    },
  };
  await ctx.provider.authorize(
    CLIENT,
    { codeChallenge: 'c', redirectUri: 'https://example.com/cb', state: 'st-2' },
    res,
  );
  const requestId = new URL(redirected, 'http://x').searchParams.get('request')!;
  const result = await ctx.provider.completeAuthorization(requestId, ctx.userId, false);
  assert.ok(result);
  const url = new URL(result.redirectTo);
  assert.equal(url.searchParams.get('error'), 'access_denied');
  assert.equal(url.searchParams.get('state'), 'st-2');
  assert.equal(url.searchParams.get('code'), null);
  // 同じ request id は消費済み。
  assert.equal(await ctx.provider.completeAuthorization(requestId, ctx.userId, true), null);
});

test('認可コードは one-time: 二度目の交換は invalid_grant', async () => {
  const ctx = await makeCtx();
  const code = await obtainCode(ctx);
  await ctx.provider.exchangeAuthorizationCode(CLIENT, code);
  await assert.rejects(ctx.provider.exchangeAuthorizationCode(CLIENT, code), /invalid/);
});

test('他クライアントのコードは交換できない', async () => {
  const ctx = await makeCtx();
  const code = await obtainCode(ctx);
  await assert.rejects(ctx.provider.exchangeAuthorizationCode(OTHER_CLIENT, code), /invalid/);
  await assert.rejects(ctx.provider.challengeForAuthorizationCode(OTHER_CLIENT, code), /invalid/);
});

test('期限切れコードは challenge 参照も交換も拒否', async () => {
  const ctx = await makeCtx();
  const code = await obtainCode(ctx);
  ctx.setNow(new Date(Date.parse('2026-07-18T00:00:00Z') + OAUTH_CODE_TTL_MS + 1));
  await assert.rejects(ctx.provider.challengeForAuthorizationCode(CLIENT, code), /expired/);
  await assert.rejects(ctx.provider.exchangeAuthorizationCode(CLIENT, code), /expired/);
});

test('redirect_uri が認可時と異なる交換は拒否', async () => {
  const ctx = await makeCtx();
  const code = await obtainCode(ctx);
  await assert.rejects(
    ctx.provider.exchangeAuthorizationCode(CLIENT, code, undefined, 'https://evil.example/cb'),
    /redirect_uri/,
  );
});

test('リフレッシュはローテーションし、旧 refresh・旧 access は無効になる', async () => {
  const ctx = await makeCtx();
  const code = await obtainCode(ctx);
  const first = await ctx.provider.exchangeAuthorizationCode(CLIENT, code);
  const second = await ctx.provider.exchangeRefreshToken(CLIENT, first.refresh_token!);
  assert.ok(second.access_token);
  // 旧グラントはレコードごと消えている。
  await assert.rejects(ctx.provider.verifyAccessToken(first.access_token), /invalid/);
  await assert.rejects(ctx.provider.exchangeRefreshToken(CLIENT, first.refresh_token!), /invalid/);
  // 新しいアクセストークンは有効。
  const info = await ctx.provider.verifyAccessToken(second.access_token);
  assert.equal(info.clientId, 'client-1');
});

test('他クライアントの refresh token は使えない', async () => {
  const ctx = await makeCtx();
  const code = await obtainCode(ctx);
  const tokens = await ctx.provider.exchangeAuthorizationCode(CLIENT, code);
  await assert.rejects(
    ctx.provider.exchangeRefreshToken(OTHER_CLIENT, tokens.refresh_token!),
    /invalid/,
  );
});

test('付与済みスコープを超える refresh 要求は invalid_scope', async () => {
  const ctx = await makeCtx();
  const code = await obtainCode(ctx);
  const tokens = await ctx.provider.exchangeAuthorizationCode(CLIENT, code);
  await assert.rejects(
    ctx.provider.exchangeRefreshToken(CLIENT, tokens.refresh_token!, ['mcp', 'admin']),
    /scope/,
  );
});

test('期限切れアクセストークンは verify で拒否される', async () => {
  const ctx = await makeCtx();
  const code = await obtainCode(ctx);
  const tokens = await ctx.provider.exchangeAuthorizationCode(CLIENT, code);
  ctx.setNow(new Date(Date.parse('2026-07-18T00:00:00Z') + OAUTH_ACCESS_TTL_MS + 1));
  await assert.rejects(ctx.provider.verifyAccessToken(tokens.access_token), /expired/);
});

test('revoke は自クライアントのトークンだけを失効し、他は黙って無視する', async () => {
  const ctx = await makeCtx();
  const code = await obtainCode(ctx);
  const tokens = await ctx.provider.exchangeAuthorizationCode(CLIENT, code);
  // 他クライアントからの失効要求は no-op。
  await ctx.provider.revokeToken(OTHER_CLIENT, { token: tokens.access_token });
  await ctx.provider.verifyAccessToken(tokens.access_token);
  // 自クライアントからは access でも refresh でも失効できる。
  await ctx.provider.revokeToken(CLIENT, { token: tokens.access_token });
  await assert.rejects(ctx.provider.verifyAccessToken(tokens.access_token), /invalid/);
  // 不明トークンはエラーにしない。
  await ctx.provider.revokeToken(CLIENT, { token: 'unknown' });
});

test('DCR 上限: 100 件が全て使用中(トークン発行済み)なら新規登録は拒否される', async () => {
  const repos = createMemoryRepositories();
  const provider = new RssOAuthProvider({ repos });
  const user = await repos.users.create({ username: 'owner', passwordHash: 'h' });
  const register = (info: OAuthClientInformationFull) =>
    Promise.resolve(provider.clientsStore.registerClient!(info));
  // 100 件を登録し、全てトークンを発行して「使用中」にする(追い出し対象がゼロ)。
  for (let i = 0; i < 100; i += 1) {
    await register({
      client_id: `used-${i}`,
      redirect_uris: ['https://example.com/cb'],
      token_endpoint_auth_method: 'none',
    });
    await repos.oauthTokens.create({
      clientId: `used-${i}`,
      userId: user.id,
      scopes: ['mcp'],
      accessTokenHash: `a-${i}`,
      accessExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenHash: `r-${i}`,
      refreshExpiresAt: new Date(Date.now() + 86_400_000),
    });
  }
  // 使用中クライアントは追い出さないため、これ以上は登録できない。
  await assert.rejects(
    register({
      client_id: 'c-over',
      redirect_uris: ['https://example.com/cb'],
      token_endpoint_auth_method: 'none',
    }),
    /full/,
  );
});

test('PT-002: 満杯を新鮮な未使用クライアントで維持されても、正規登録は最古未使用の追い出しで常に通る', async () => {
  const repos = createMemoryRepositories();
  const provider = new RssOAuthProvider({ repos });
  const register = (info: OAuthClientInformationFull) =>
    Promise.resolve(provider.clientsStore.registerClient!(info));
  // 攻撃者が新鮮(=24h TTL 未満)な未使用クライアントで 100 枠を埋める。
  for (let i = 0; i < 100; i += 1) {
    await register({
      client_id: `attacker-${i}`,
      redirect_uris: ['https://evil.example/cb'],
      token_endpoint_auth_method: 'none',
    });
  }
  // 24h 掃除では新鮮なので1件も回収されないが、正規クライアントの登録は
  // 最古の未使用(attacker-0)を追い出して成立する。
  await register(CLIENT);
  assert.notEqual(await repos.oauthClients.getById('client-1'), null);
  assert.equal(await repos.oauthClients.getById('attacker-0'), null, '最古の未使用が追い出される');
  assert.equal(await repos.oauthClients.count(), 100, '総数は上限内に保たれる');
});

test('PT-002: 24h 経過した未使用クライアントは次の登録時に一括回収される(TTL 掃除)', async () => {
  const repos = createMemoryRepositories();
  // createdAt はリポジトリの実クロックで刻まれるため、注入クロックも実時刻を起点にする。
  let now = new Date();
  const provider = new RssOAuthProvider({ repos, now: () => now });
  const register = (info: OAuthClientInformationFull) =>
    Promise.resolve(provider.clientsStore.registerClient!(info));

  // t0 で上限 100 まで未使用クライアントを登録。
  for (let i = 0; i < 100; i += 1) {
    await register({
      client_id: `filler-${i}`,
      redirect_uris: ['https://example.com/cb'],
      token_endpoint_auth_method: 'none',
    });
  }

  // 25 時間経過。次の登録時に TTL 掃除が古い未使用を「一括」回収する
  // (単発の追い出しではなく deleteUnusedBefore による全件回収)。
  now = new Date(now.getTime() + 25 * 60 * 60_000);
  await register(CLIENT);
  assert.notEqual(await repos.oauthClients.getById('client-1'), null);
  assert.equal(await repos.oauthClients.getById('filler-0'), null);
  // 100 件が一括回収され、残るのは新規の CLIENT のみ(追い出しなら 100 のまま)。
  assert.equal(await repos.oauthClients.count(), 1, '古い未使用は一括回収される');
});

test('PT-002: トークンを発行した正規クライアントは TTL 超過でも回収されない', async () => {
  const repos = createMemoryRepositories();
  let now = new Date();
  const provider = new RssOAuthProvider({ repos, now: () => now });
  const user = await repos.users.create({ username: 'owner', passwordHash: 'h' });
  await Promise.resolve(provider.clientsStore.registerClient!(CLIENT));
  // CLIENT がトークンを発行済みにする。
  await repos.oauthTokens.create({
    clientId: CLIENT.client_id,
    userId: user.id,
    scopes: ['mcp'],
    accessTokenHash: 'ah',
    accessExpiresAt: new Date(now.getTime() + 3_600_000),
    refreshTokenHash: 'rh',
    refreshExpiresAt: new Date(now.getTime() + 86_400_000),
  });
  now = new Date(now.getTime() + 25 * 60 * 60_000);
  // 別クライアント登録で prune が走っても、使用中の CLIENT は残る。
  await Promise.resolve(provider.clientsStore.registerClient!(OTHER_CLIENT));
  assert.notEqual(await repos.oauthClients.getById(CLIENT.client_id), null);
});
