import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../src/server/app.ts';
import { createMemoryRepositories } from '../../src/repo/memory/index.ts';
import { hashPassword } from '../../src/server/password.ts';
import type { Repositories } from '../../src/domain/repositories.ts';

/**
 * /login のブルートフォース対策(設計書 §7 / docs/004_KnownLimitations.md §7)の
 * HTTP 経由の回帰テスト。既定閾値(maxPerKey=5 / window=15分)で検証する。
 */

const ADMIN = 'admin';
const PASSWORD = 'correct-horse-battery';

interface TestApp {
  base: string;
  clock: { current: Date };
  close: () => Promise<void>;
  repos: Repositories;
}

async function startApp(): Promise<TestApp> {
  const repos = createMemoryRepositories();
  await repos.users.create({ username: ADMIN, passwordHash: await hashPassword(PASSWORD) });
  const clock = { current: new Date('2026-07-17T00:00:00Z') };
  const app: Server = createApp({
    repos,
    runCollect: async () => ({}),
    mcpBearerToken: 'mcp-token',
    collectorToken: 'collector-token',
    cacheFulltext: false,
    now: () => clock.current,
  });
  await new Promise<void>((resolve) => app.listen(0, resolve));
  const { port } = app.address() as AddressInfo;
  return {
    base: `http://localhost:${port}`,
    clock,
    repos,
    close: () => new Promise((resolve) => app.close(() => resolve())),
  };
}

function login(base: string, username: string, password: string): Promise<Response> {
  return fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ username, password }).toString(),
  });
}

test('login throttle: 閾値到達で 429 + Retry-After を返す', async () => {
  const app = await startApp();
  try {
    for (let i = 0; i < 5; i++) {
      const res = await login(app.base, ADMIN, 'wrong-password');
      assert.equal(res.status, 401, `attempt ${i + 1} は 401`);
    }
    // 6回目はブロック
    const blocked = await login(app.base, ADMIN, 'wrong-password');
    assert.equal(blocked.status, 429);
    const retryAfter = Number(blocked.headers.get('retry-after'));
    assert.ok(retryAfter > 0 && retryAfter <= 15 * 60, `Retry-After=${retryAfter}`);
  } finally {
    await app.close();
  }
});

test('login throttle: ブロック中は正しいパスワードでも 429(検証前に遮断)', async () => {
  const app = await startApp();
  try {
    for (let i = 0; i < 5; i++) await login(app.base, ADMIN, 'wrong-password');
    const res = await login(app.base, ADMIN, PASSWORD);
    assert.equal(res.status, 429, '総当たりで枯渇後は正しい資格情報も遮断される');
  } finally {
    await app.close();
  }
});

test('login throttle: ウィンドウ経過後は回復し、正しいパスワードでログインできる', async () => {
  const app = await startApp();
  try {
    for (let i = 0; i < 6; i++) await login(app.base, ADMIN, 'wrong-password');
    // 15分 + 1秒 進める → 失敗履歴が窓外へ
    app.clock.current = new Date(app.clock.current.getTime() + 15 * 60_000 + 1000);
    const res = await login(app.base, ADMIN, PASSWORD);
    assert.equal(res.status, 303, '回復後は正しい資格情報でログイン成功(303 リダイレクト)');
    assert.ok(res.headers.get('set-cookie')?.includes('session='), 'セッション Cookie が発行される');
  } finally {
    await app.close();
  }
});

test('login throttle: 成功時にカウンタがリセットされる', async () => {
  const app = await startApp();
  try {
    // 4回失敗(閾値5未満)→ 成功でリセット
    for (let i = 0; i < 4; i++) await login(app.base, ADMIN, 'wrong-password');
    const ok = await login(app.base, ADMIN, PASSWORD);
    assert.equal(ok.status, 303);
    // リセット後、再び4回失敗しても 429 にならない(カウンタが0起点)
    for (let i = 0; i < 4; i++) {
      const res = await login(app.base, ADMIN, 'wrong-password');
      assert.equal(res.status, 401, `reset 後 attempt ${i + 1} は 401(まだブロックされない)`);
    }
  } finally {
    await app.close();
  }
});
