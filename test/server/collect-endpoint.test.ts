import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp, type AppDeps } from '../../src/server/app.ts';
import { createMemoryRepositories } from '../../src/repo/memory/index.ts';

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

const COLLECTOR_TOKEN = 'collector-secret';
const BEARER = 'bearer-secret';

function baseDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    repos: createMemoryRepositories(),
    runCollect: async () => ({ totalInserted: 0 }),
    mcpBearerToken: BEARER,
    collectorToken: COLLECTOR_TOKEN,
    cacheFulltext: false,
    ...overrides,
  };
}

test('GET /healthz returns 200 ok without auth', async () => {
  const { url, close } = await listen(createApp(baseDeps()));
  try {
    const res = await fetch(`${url}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  } finally {
    await close();
  }
});

test('POST /internal/collect without token -> 401, no hint in body', async () => {
  let called = false;
  const { url, close } = await listen(
    createApp(
      baseDeps({
        runCollect: async () => {
          called = true;
          return {};
        },
      }),
    ),
  );
  try {
    const res = await fetch(`${url}/internal/collect`, { method: 'POST' });
    assert.equal(res.status, 401);
    const body = await res.text();
    assert.equal(/collector-secret/.test(body), false);
    assert.equal(called, false, 'collect must not run when unauthorized');
  } finally {
    await close();
  }
});

test('POST /internal/collect with wrong token -> 401', async () => {
  const { url, close } = await listen(createApp(baseDeps()));
  try {
    const res = await fetch(`${url}/internal/collect`, {
      method: 'POST',
      headers: { 'x-collector-token': 'wrong' },
    });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test('POST /internal/collect with correct token -> 200 with result', async () => {
  const { url, close } = await listen(
    createApp(baseDeps({ runCollect: async () => ({ totalInserted: 3 }) })),
  );
  try {
    const res = await fetch(`${url}/internal/collect`, {
      method: 'POST',
      headers: { 'x-collector-token': COLLECTOR_TOKEN },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok', result: { totalInserted: 3 } });
  } finally {
    await close();
  }
});

test('single-flight: two concurrent collects call runCollect only once', async () => {
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const { url, close } = await listen(
    createApp(
      baseDeps({
        runCollect: async () => {
          calls += 1;
          await gate;
          return { calls };
        },
      }),
    ),
  );
  try {
    const headers = { 'x-collector-token': COLLECTOR_TOKEN };
    const p1 = fetch(`${url}/internal/collect`, { method: 'POST', headers });
    const p2 = fetch(`${url}/internal/collect`, { method: 'POST', headers });
    // 両リクエストがハンドラに到達するのを待ってから解放。
    await new Promise((r) => setTimeout(r, 100));
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
    assert.equal(calls, 1, 'runCollect must be invoked exactly once');
    assert.deepEqual(b1, { status: 'ok', result: { calls: 1 } });
    assert.deepEqual(b2, { status: 'ok', result: { calls: 1 } });
  } finally {
    await close();
  }
});

test('after in-flight completes, a subsequent collect runs again', async () => {
  let calls = 0;
  const { url, close } = await listen(
    createApp(
      baseDeps({
        runCollect: async () => {
          calls += 1;
          return { calls };
        },
      }),
    ),
  );
  try {
    const headers = { 'x-collector-token': COLLECTOR_TOKEN };
    await fetch(`${url}/internal/collect`, { method: 'POST', headers });
    await fetch(`${url}/internal/collect`, { method: 'POST', headers });
    assert.equal(calls, 2);
  } finally {
    await close();
  }
});

test('unknown route -> 404; GET /internal/collect -> 405', async () => {
  const { url, close } = await listen(createApp(baseDeps()));
  try {
    assert.equal((await fetch(`${url}/nope`)).status, 404);
    assert.equal((await fetch(`${url}/internal/collect`)).status, 405);
  } finally {
    await close();
  }
});
