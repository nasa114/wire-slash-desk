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

test('DCR 上限: 100 クライアントを超える登録は拒否される', async () => {
  const repos = createMemoryRepositories();
  const provider = new RssOAuthProvider({ repos });
  const register = (info: OAuthClientInformationFull) =>
    Promise.resolve(provider.clientsStore.registerClient!(info));
  for (let i = 0; i < 98; i += 1) {
    await register({
      client_id: `c-${i}`,
      redirect_uris: ['https://example.com/cb'],
      token_endpoint_auth_method: 'none',
    });
  }
  // 98 + 2 で丁度上限の 100。
  await register(CLIENT);
  await register(OTHER_CLIENT);
  await assert.rejects(
    register({
      client_id: 'c-over',
      redirect_uris: ['https://example.com/cb'],
      token_endpoint_auth_method: 'none',
    }),
    /full/,
  );
});
