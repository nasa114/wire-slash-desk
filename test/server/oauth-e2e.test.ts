import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../src/server/app.ts';
import { createMemoryRepositories } from '../../src/repo/memory/index.ts';
import type { Repositories } from '../../src/domain/repositories.ts';

/**
 * MCP OAuth 2.1(T4-2)の HTTP 結合テスト。
 * DCR → authorize(ログイン+同意) → token(PKCE) → /mcp 呼び出しまでを実サーバーで検証する。
 */

const ADMIN_USER = 'admin';
const ADMIN_PASSWORD = 'test-password-123';
const STATIC_BEARER = 'mcp-token';
const ISSUER = 'http://localhost';
const REDIRECT_URI = 'http://127.0.0.1:9999/cb';

interface TestApp {
  repos: Repositories;
  base: string;
  clock: { current: Date };
  close: () => Promise<void>;
}

async function startApp(opts: { oauth?: boolean } = { oauth: true }): Promise<TestApp> {
  const repos = createMemoryRepositories();
  const clock = { current: new Date() };
  const app: Server = createApp({
    repos,
    runCollect: async () => ({}),
    mcpBearerToken: STATIC_BEARER,
    collectorToken: 'collector-token',
    cacheFulltext: false,
    now: () => clock.current,
    ...(opts.oauth !== false ? { oauthIssuerUrl: ISSUER } : {}),
  });
  await new Promise<void>((resolve) => app.listen(0, resolve));
  const { port } = app.address() as AddressInfo;
  return {
    repos,
    clock,
    base: `http://localhost:${port}`,
    close: () => new Promise((resolve) => app.close(() => resolve())),
  };
}

function postForm(
  base: string,
  path: string,
  body: Record<string, string>,
  opts: { cookie?: string } = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: base,
      ...(opts.cookie !== undefined ? { cookie: opts.cookie } : {}),
    },
    body: new URLSearchParams(body).toString(),
  });
}

async function loginCookie(base: string): Promise<string> {
  const setup = await postForm(base, '/setup', {
    username: ADMIN_USER,
    password: ADMIN_PASSWORD,
    password_confirm: ADMIN_PASSWORD,
  });
  assert.equal(setup.status, 303);
  const res = await postForm(base, '/login', { username: ADMIN_USER, password: ADMIN_PASSWORD });
  assert.equal(res.status, 303);
  const setCookie = res.headers.getSetCookie().find((v) => v.startsWith('session='));
  assert.ok(setCookie);
  return setCookie.split(';', 1)[0] as string;
}

interface Pkce {
  verifier: string;
  challenge: string;
}

function makePkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

async function registerClient(base: string): Promise<string> {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'E2E Test Client',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  assert.equal(res.status, 201, 'DCR は 201 を返すこと');
  const body = (await res.json()) as { client_id?: string; client_secret?: string };
  assert.ok(body.client_id);
  assert.equal(body.client_secret, undefined, '公開クライアントに secret は発行されない');
  return body.client_id;
}

/** authorize → ログイン → 同意承認まで進めて認可コードを取り出す。 */
async function authorizeAndConsent(
  base: string,
  clientId: string,
  pkce: Pkce,
  cookie: string,
  state = 'e2e-state',
): Promise<string> {
  const authorizeUrl =
    `${base}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&code_challenge=${pkce.challenge}&code_challenge_method=S256&state=${state}`;
  const authz = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(authz.status, 302, '/authorize は同意画面へリダイレクトすること');
  const consentPath = authz.headers.get('location');
  assert.ok(consentPath?.startsWith('/oauth/consent?request='));

  // 未ログインでは同意画面はログインへ誘導する。
  const anon = await fetch(`${base}${consentPath}`, { redirect: 'manual' });
  assert.equal(anon.status, 302);
  assert.ok(anon.headers.get('location')?.startsWith('/login?next='));

  // ログイン済みなら同意画面が表示される。
  const page = await fetch(`${base}${consentPath}`, {
    redirect: 'manual',
    headers: { cookie },
  });
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /E2E Test Client/);
  assert.match(pageHtml, /許可する/);

  const requestId = new URL(`${base}${consentPath}`).searchParams.get('request') as string;
  const consent = await postForm(
    base,
    '/oauth/consent',
    { request: requestId, action: 'approve' },
    { cookie },
  );
  assert.equal(consent.status, 303);
  const redirected = new URL(consent.headers.get('location') as string);
  assert.equal(redirected.origin + redirected.pathname, REDIRECT_URI);
  assert.equal(redirected.searchParams.get('state'), state);
  const code = redirected.searchParams.get('code');
  assert.ok(code, '承認で認可コードが発行されること');
  return code;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
}

async function exchangeCode(
  base: string,
  clientId: string,
  code: string,
  verifier: string,
): Promise<TokenResponse> {
  const res = await postForm(base, '/token', {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  });
  assert.equal(res.status, 200, `token 交換は 200 のこと: ${await res.clone().text()}`);
  return (await res.json()) as TokenResponse;
}

/** /mcp への最小 JSON-RPC リクエスト。認証の可否(401 か否か)の判定に使う。 */
function callMcp(base: string, authorization?: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(authorization !== undefined ? { authorization } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
    }),
  });
}

test('well-known メタデータ: AS メタデータと PRM が公開される', async () => {
  const app = await startApp();
  try {
    const as = await fetch(`${app.base}/.well-known/oauth-authorization-server`);
    assert.equal(as.status, 200);
    const asBody = (await as.json()) as Record<string, unknown>;
    assert.equal(asBody['issuer'], `${ISSUER}/`);
    assert.equal(asBody['authorization_endpoint'], `${ISSUER}/authorize`);
    assert.equal(asBody['token_endpoint'], `${ISSUER}/token`);
    assert.equal(asBody['registration_endpoint'], `${ISSUER}/register`);
    assert.deepEqual(asBody['code_challenge_methods_supported'], ['S256']);

    const prm = await fetch(`${app.base}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(prm.status, 200);
    const prmBody = (await prm.json()) as Record<string, unknown>;
    assert.equal(prmBody['resource'], `${ISSUER}/mcp`);
    assert.deepEqual(prmBody['authorization_servers'], [`${ISSUER}/`]);
  } finally {
    await app.close();
  }
});

test('OAUTH_ISSUER_URL 未設定なら OAuth エンドポイントは存在しない(従来動作)', async () => {
  const app = await startApp({ oauth: false });
  try {
    assert.equal((await fetch(`${app.base}/.well-known/oauth-authorization-server`)).status, 404);
    const authz = await fetch(`${app.base}/authorize?client_id=x`, { redirect: 'manual' });
    // Hono(Web UI)側にルートが無いため 404。
    assert.equal(authz.status, 404);
    const mcp = await callMcp(app.base, 'Bearer wrong');
    assert.equal(mcp.status, 401);
    assert.equal(mcp.headers.get('www-authenticate'), 'Bearer');
  } finally {
    await app.close();
  }
});

test('E2E: DCR → 認可(ログイン+同意) → PKCE トークン交換 → /mcp 呼び出し', async () => {
  const app = await startApp();
  try {
    const cookie = await loginCookie(app.base);
    const clientId = await registerClient(app.base);
    const pkce = makePkce();
    const code = await authorizeAndConsent(app.base, clientId, pkce, cookie);
    const tokens = await exchangeCode(app.base, clientId, code, pkce.verifier);
    assert.equal(tokens.token_type, 'bearer');
    assert.equal(tokens.scope, 'mcp');
    assert.ok(tokens.refresh_token);

    // OAuth アクセストークンで /mcp が認証を通る(401 でない)。
    const ok = await callMcp(app.base, `Bearer ${tokens.access_token}`);
    assert.notEqual(ok.status, 401);
    // 静的 Bearer も引き続き有効(Codex 等 OAuth 非対応クライアント向け共存)。
    const legacy = await callMcp(app.base, `Bearer ${STATIC_BEARER}`);
    assert.notEqual(legacy.status, 401);
  } finally {
    await app.close();
  }
});

test('E2E: 不正トークンは 401 + WWW-Authenticate に resource_metadata が載る', async () => {
  const app = await startApp();
  try {
    const res = await callMcp(app.base, 'Bearer bogus-token');
    assert.equal(res.status, 401);
    assert.equal(
      res.headers.get('www-authenticate'),
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`,
    );
    const noAuth = await callMcp(app.base);
    assert.equal(noAuth.status, 401);
  } finally {
    await app.close();
  }
});

test('E2E: PKCE verifier 不一致・コード再利用は invalid_grant', async () => {
  const app = await startApp();
  try {
    const cookie = await loginCookie(app.base);
    const clientId = await registerClient(app.base);

    // verifier 不一致。
    const pkce1 = makePkce();
    const code1 = await authorizeAndConsent(app.base, clientId, pkce1, cookie, 's1');
    const bad = await postForm(app.base, '/token', {
      grant_type: 'authorization_code',
      client_id: clientId,
      code: code1,
      code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier',
      redirect_uri: REDIRECT_URI,
    });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error?: string }).error, 'invalid_grant');

    // 正しい交換 → 同じコードの再利用は拒否。
    const pkce2 = makePkce();
    const code2 = await authorizeAndConsent(app.base, clientId, pkce2, cookie, 's2');
    await exchangeCode(app.base, clientId, code2, pkce2.verifier);
    const replay = await postForm(app.base, '/token', {
      grant_type: 'authorization_code',
      client_id: clientId,
      code: code2,
      code_verifier: pkce2.verifier,
      redirect_uri: REDIRECT_URI,
    });
    assert.equal(replay.status, 400);
    assert.equal(((await replay.json()) as { error?: string }).error, 'invalid_grant');
  } finally {
    await app.close();
  }
});

test('E2E: 同意拒否は access_denied を返しトークンは発行されない', async () => {
  const app = await startApp();
  try {
    const cookie = await loginCookie(app.base);
    const clientId = await registerClient(app.base);
    const pkce = makePkce();
    const authorizeUrl =
      `${app.base}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&code_challenge=${pkce.challenge}&code_challenge_method=S256&state=deny-state`;
    const authz = await fetch(authorizeUrl, { redirect: 'manual' });
    const consentPath = authz.headers.get('location') as string;
    const requestId = new URL(`${app.base}${consentPath}`).searchParams.get('request') as string;
    const consent = await postForm(
      app.base,
      '/oauth/consent',
      { request: requestId, action: 'deny' },
      { cookie },
    );
    assert.equal(consent.status, 303);
    const redirected = new URL(consent.headers.get('location') as string);
    assert.equal(redirected.searchParams.get('error'), 'access_denied');
    assert.equal(redirected.searchParams.get('state'), 'deny-state');
    assert.equal(redirected.searchParams.get('code'), null);
  } finally {
    await app.close();
  }
});

test('E2E: refresh ローテーションで新トークン発行・旧アクセストークンは失効まで有効', async () => {
  const app = await startApp();
  try {
    const cookie = await loginCookie(app.base);
    const clientId = await registerClient(app.base);
    const pkce = makePkce();
    const code = await authorizeAndConsent(app.base, clientId, pkce, cookie);
    const first = await exchangeCode(app.base, clientId, code, pkce.verifier);

    const refreshed = await postForm(app.base, '/token', {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: first.refresh_token as string,
    });
    assert.equal(refreshed.status, 200);
    const second = (await refreshed.json()) as TokenResponse;
    assert.ok(second.access_token);

    // ローテーション: 旧グラント(旧アクセストークン)はレコードごと失効する。
    const oldAccess = await callMcp(app.base, `Bearer ${first.access_token}`);
    assert.equal(oldAccess.status, 401);
    const newAccess = await callMcp(app.base, `Bearer ${second.access_token}`);
    assert.notEqual(newAccess.status, 401);
    // 旧 refresh の再利用も拒否。
    const reuse = await postForm(app.base, '/token', {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: first.refresh_token as string,
    });
    assert.equal(reuse.status, 400);
  } finally {
    await app.close();
  }
});

test('E2E: 未登録 redirect_uri の authorize は同意に進まない', async () => {
  const app = await startApp();
  try {
    const clientId = await registerClient(app.base);
    const pkce = makePkce();
    const authorizeUrl =
      `${app.base}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent('http://evil.example/cb')}` +
      `&code_challenge=${pkce.challenge}&code_challenge_method=S256`;
    const res = await fetch(authorizeUrl, { redirect: 'manual' });
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test('login next: 検証済み相対パスのみリダイレクト先に採用する', async () => {
  const app = await startApp();
  try {
    await postForm(app.base, '/setup', {
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
      password_confirm: ADMIN_PASSWORD,
    });
    // 安全な next は採用。
    const ok = await postForm(app.base, '/login', {
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
      next: '/oauth/consent?request=abc',
    });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), '/oauth/consent?request=abc');
    // 外部 URL・スキーム相対は既定の / へフォールバック。
    for (const evil of ['https://evil.example/', '//evil.example/', '/\\evil.example']) {
      const res = await postForm(app.base, '/login', {
        username: ADMIN_USER,
        password: ADMIN_PASSWORD,
        next: evil,
      });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/', `next=${evil} は拒否されること`);
    }
  } finally {
    await app.close();
  }
});
