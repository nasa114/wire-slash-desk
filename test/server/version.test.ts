import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { loadBuildInfo } from '../../src/server/build-info.ts';
import { createApp, type AppDeps } from '../../src/server/app.ts';
import { createMemoryRepositories } from '../../src/repo/memory/index.ts';

/* ------------------------------------------------------------ loadBuildInfo */

/** package.json + .git を持つ一時ディレクトリを作る(rootDir 注入用)。 */
function makeRoot(opts: {
  version?: string;
  head?: string;
  refs?: Record<string, string>;
  packedRefs?: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'build-info-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: opts.version ?? '1.2.3' }));
  if (opts.head !== undefined) {
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), opts.head);
    for (const [ref, hash] of Object.entries(opts.refs ?? {})) {
      const refPath = join(dir, '.git', ref);
      mkdirSync(join(refPath, '..'), { recursive: true });
      writeFileSync(refPath, `${hash}\n`);
    }
    if (opts.packedRefs !== undefined) {
      writeFileSync(join(dir, '.git', 'packed-refs'), opts.packedRefs);
    }
  }
  return dir;
}

const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

test('build-info: GIT_COMMIT 環境変数が最優先される(短縮ハッシュ可)', () => {
  const dir = makeRoot({ head: `ref: refs/heads/main\n`, refs: { 'refs/heads/main': HASH } });
  try {
    const info = loadBuildInfo({ GIT_COMMIT: 'abc1234' }, dir);
    assert.equal(info.commit, 'abc1234');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('build-info: GIT_COMMIT がハッシュ形式でなければ無視して .git へフォールバック', () => {
  const dir = makeRoot({ head: `ref: refs/heads/main\n`, refs: { 'refs/heads/main': HASH } });
  try {
    // Dockerfile の既定値 'unknown' や誤設定文字列は形式検証で弾かれる。
    assert.equal(loadBuildInfo({ GIT_COMMIT: 'unknown' }, dir).commit, HASH);
    assert.equal(loadBuildInfo({ GIT_COMMIT: '<script>' }, dir).commit, HASH);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('build-info: env が無ければ .git/HEAD → ref ファイルを読む', () => {
  const dir = makeRoot({ head: `ref: refs/heads/main\n`, refs: { 'refs/heads/main': HASH } });
  try {
    const info = loadBuildInfo({}, dir);
    assert.equal(info.commit, HASH);
    assert.equal(info.version, '1.2.3');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('build-info: detached HEAD(ハッシュ直書き)を読める', () => {
  const dir = makeRoot({ head: `${HASH}\n` });
  try {
    assert.equal(loadBuildInfo({}, dir).commit, HASH);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('build-info: ref ファイルが無ければ packed-refs から引く', () => {
  const dir = makeRoot({
    head: `ref: refs/heads/main\n`,
    packedRefs: `# pack-refs with: peeled fully-peeled sorted\n${HASH} refs/heads/main\n`,
  });
  try {
    assert.equal(loadBuildInfo({}, dir).commit, HASH);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('build-info: .git が無ければ commit は unknown', () => {
  const dir = makeRoot({});
  try {
    const info = loadBuildInfo({}, dir);
    assert.equal(info.commit, 'unknown');
    assert.equal(info.version, '1.2.3');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('build-info: BUILD_TIME は空なら undefined、指定時はそのまま', () => {
  const dir = makeRoot({});
  try {
    assert.equal(loadBuildInfo({ BUILD_TIME: '' }, dir).builtAt, undefined);
    assert.equal(loadBuildInfo({}, dir).builtAt, undefined);
    assert.equal(
      loadBuildInfo({ BUILD_TIME: '2026-07-20T00:00:00Z' }, dir).builtAt,
      '2026-07-20T00:00:00Z',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('build-info: 既定 rootDir でこのリポジトリの version と commit を取得できる', () => {
  const info = loadBuildInfo({});
  assert.match(info.version, /^\d+\.\d+\.\d+/);
  assert.match(info.commit, /^[0-9a-f]{40}$/, 'dev container では .git から読めること');
});

/* --------------------------------------------------- GET /internal/version */

const COLLECTOR_TOKEN = 'collector-secret';

const BUILD_INFO = { version: '9.9.9', commit: HASH, builtAt: '2026-07-20T00:00:00Z' };

function listen(server: Server): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function baseDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    repos: createMemoryRepositories(),
    runCollect: async () => ({}),
    mcpBearerToken: 'bearer-secret',
    collectorToken: COLLECTOR_TOKEN,
    cacheFulltext: false,
    buildInfo: BUILD_INFO,
    ...overrides,
  };
}

test('GET /internal/version はトークン無しなら 401(本文にヒントを含めない)', async () => {
  const { url, close } = await listen(createApp(baseDeps()));
  try {
    const res = await fetch(`${url}/internal/version`);
    assert.equal(res.status, 401);
    const body = await res.text();
    assert.equal(/collector-secret/.test(body), false);
    assert.equal(new RegExp(HASH).test(body), false, 'コミットハッシュも返さない');
  } finally {
    await close();
  }
});

test('GET /internal/version は誤トークンなら 401', async () => {
  const { url, close } = await listen(createApp(baseDeps()));
  try {
    const res = await fetch(`${url}/internal/version`, {
      headers: { 'x-collector-token': 'wrong' },
    });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test('GET /internal/version は正トークンで version/commit/builtAt を返す', async () => {
  const { url, close } = await listen(createApp(baseDeps()));
  try {
    const res = await fetch(`${url}/internal/version`, {
      headers: { 'x-collector-token': COLLECTOR_TOKEN },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      status: 'ok',
      version: '9.9.9',
      commit: HASH,
      builtAt: '2026-07-20T00:00:00Z',
    });
  } finally {
    await close();
  }
});

test('GET /internal/version: buildInfo 未指定でも unknown で応答する', async () => {
  const deps = baseDeps();
  delete (deps as Partial<AppDeps>).buildInfo;
  const { url, close } = await listen(createApp(deps));
  try {
    const res = await fetch(`${url}/internal/version`, {
      headers: { 'x-collector-token': COLLECTOR_TOKEN },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { commit: string };
    assert.equal(body.commit, 'unknown');
  } finally {
    await close();
  }
});

test('POST /internal/version は 405', async () => {
  const { url, close } = await listen(createApp(baseDeps()));
  try {
    const res = await fetch(`${url}/internal/version`, { method: 'POST' });
    assert.equal(res.status, 405);
  } finally {
    await close();
  }
});

/* --------------------------------------------------------- Web UI フッター */

async function loggedInCookie(base: string): Promise<string> {
  const postForm = (path: string, body: Record<string, string>): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
      body: new URLSearchParams(body).toString(),
    });
  const setup = await postForm('/setup', {
    username: 'admin',
    password: 'test-password-123',
    password_confirm: 'test-password-123',
  });
  assert.equal(setup.status, 303);
  const loginRes = await postForm('/login', { username: 'admin', password: 'test-password-123' });
  assert.equal(loginRes.status, 303);
  const setCookie = loginRes.headers.getSetCookie().find((v) => v.startsWith('session='));
  assert.ok(setCookie);
  return setCookie.split(';', 1)[0] as string;
}

test('ログイン後の各ページのフッターに version と短縮 commit が表示される', async () => {
  const server = createApp(baseDeps());
  const { url, close } = await listen(server);
  try {
    const cookie = await loggedInCookie(url);
    for (const path of ['/', '/articles', '/feeds']) {
      const res = await fetch(`${url}${path}`, { headers: { cookie } });
      assert.equal(res.status, 200);
      const htmlBody = await res.text();
      assert.match(htmlBody, /v9\.9\.9/, `${path} に version が出ること`);
      assert.match(htmlBody, new RegExp(HASH.slice(0, 12)), `${path} に短縮 commit が出ること`);
    }
  } finally {
    await close();
  }
});

test('未認証ページ(/login)には version/commit を表示しない', async () => {
  const server = createApp(baseDeps());
  const { url, close } = await listen(server);
  try {
    await loggedInCookie(url); // setup を済ませ /login が表示される状態にする
    const res = await fetch(`${url}/login`);
    assert.equal(res.status, 200);
    const htmlBody = await res.text();
    assert.equal(/v9\.9\.9/.test(htmlBody), false);
    assert.equal(new RegExp(HASH.slice(0, 12)).test(htmlBody), false);
  } finally {
    await close();
  }
});
