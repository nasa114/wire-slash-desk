import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../src/server/app.ts';
import { createMemoryRepositories } from '../../src/repo/memory/index.ts';
import type { Repositories } from '../../src/domain/repositories.ts';
import type { RateView } from '../../src/rates/service.ts';

/**
 * 為替レートウィジェットの Web UI テスト(T4-3、設計書 §14)。
 * セットアップは test/server/web.test.ts と同じ手法(createApp + memory repos + フォームログイン)。
 * レート取得は deps.getRates の注入 fake で行い、外部ネットワークには触れない。
 */

const ADMIN_USER = 'admin';
const ADMIN_PASSWORD = 'test-password-123';

interface TestApp {
  repos: Repositories;
  base: string;
  close: () => Promise<void>;
}

async function startApp(opts: { getRates?: () => Promise<RateView[]> } = {}): Promise<TestApp> {
  const repos = createMemoryRepositories();
  const app: Server = createApp({
    repos,
    runCollect: async () => ({}),
    mcpBearerToken: 'mcp-token',
    collectorToken: 'collector-token',
    cacheFulltext: false,
    ...(opts.getRates !== undefined ? { getRates: opts.getRates } : {}),
  });
  await new Promise<void>((resolve) => app.listen(0, resolve));
  const { port } = app.address() as AddressInfo;
  return {
    repos,
    base: `http://localhost:${port}`,
    close: () => new Promise((resolve) => app.close(() => resolve())),
  };
}

/** フォーム POST(同一オリジンの Origin ヘッダ付き。CSRF ミドルウェアを通すため必須)。 */
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

function getPage(base: string, path: string, cookie?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    redirect: 'manual',
    ...(cookie !== undefined ? { headers: { cookie } } : {}),
  });
}

/** setup + login してセッション Cookie 付きのアプリを返す。 */
async function startLoggedIn(
  opts: { getRates?: () => Promise<RateView[]> } = {},
): Promise<TestApp & { cookie: string }> {
  const app = await startApp(opts);
  const setup = await postForm(app.base, '/setup', {
    username: ADMIN_USER,
    password: ADMIN_PASSWORD,
    password_confirm: ADMIN_PASSWORD,
  });
  assert.equal(setup.status, 303, 'setup は成功すること');
  const login = await postForm(app.base, '/login', { username: ADMIN_USER, password: ADMIN_PASSWORD });
  assert.equal(login.status, 303, 'login は成功すること');
  const setCookie = login.headers.getSetCookie().find((v) => v.startsWith('session='));
  assert.ok(setCookie, 'Set-Cookie: session が返ること');
  return { ...app, cookie: setCookie.split(';', 1)[0] as string };
}

function rateView(pair: string, rate: number, stale = false): RateView {
  return {
    pair,
    rate,
    prevClose: rate - 0.5,
    marketTime: new Date('2026-07-21T06:00:00Z'),
    fetchedAt: new Date('2026-07-21T09:00:00Z'),
    stale,
  };
}

/** stale マーカー(class 名に 'stale' を含む要素)の検出。 */
const STALE_CLASS = /class="[^"]*\bstale\b[^"]*"/;

test('rates: getRates が返す各ペアがダッシュボードに表示される(ラベルと現在値)', async () => {
  const { base, cookie, close } = await startLoggedIn({
    getRates: async () => [rateView('USDJPY', 147.61), rateView('EURJPY', 171.42)],
  });
  try {
    const res = await getPage(base, '/', cookie);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /USD\/JPY/, 'ペアのラベルは USD/JPY 形式で表示される');
    assert.match(html, /147\.61/, '現在値が表示される');
    assert.match(html, /EUR\/JPY/);
    assert.match(html, /171\.42/);
  } finally {
    await close();
  }
});

test('rates: stale:true のレートには stale マーカー(class)が付く', async () => {
  const { base, cookie, close } = await startLoggedIn({
    getRates: async () => [rateView('USDJPY', 147.61, true)],
  });
  try {
    const html = await (await getPage(base, '/', cookie)).text();
    assert.match(html, /USD\/JPY/);
    assert.match(html, STALE_CLASS, "stale レートには class 名 'stale' を含む要素が付く");
  } finally {
    await close();
  }
});

test('rates: stale:false のレートには stale マーカーが付かない', async () => {
  const { base, cookie, close } = await startLoggedIn({
    getRates: async () => [rateView('USDJPY', 147.61, false)],
  });
  try {
    const html = await (await getPage(base, '/', cookie)).text();
    assert.match(html, /USD\/JPY/);
    assert.ok(!STALE_CLASS.test(html), '新鮮なレートに stale クラスは付かない');
  } finally {
    await close();
  }
});

test('rates: getRates 未指定ならダッシュボードは従来どおり表示され為替要素が無い', async () => {
  const { base, cookie, close } = await startLoggedIn();
  try {
    const res = await getPage(base, '/', cookie);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /今日のトレンド/, '既存ダッシュボードは表示される');
    assert.ok(!html.includes('USD/JPY'), '為替の表示は無い');
  } finally {
    await close();
  }
});

test('rates: getRates が空配列を返すときも為替要素が無い', async () => {
  const { base, cookie, close } = await startLoggedIn({ getRates: async () => [] });
  try {
    const res = await getPage(base, '/', cookie);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /今日のトレンド/);
    assert.ok(!html.includes('USD/JPY'), '為替の表示は無い');
    assert.ok(!STALE_CLASS.test(html));
  } finally {
    await close();
  }
});

test('rates: getRates が throw してもダッシュボードは 200 で表示される(為替以外は無事)', async () => {
  const { repos, base, cookie, close } = await startLoggedIn({
    getRates: async () => {
      throw new Error('rates backend down');
    },
  });
  try {
    // 為替以外のコンテンツが無事なことを確認するため記事を1件入れておく
    const feed = await repos.feeds.create({ name: 'RatesFeed', feedUrl: 'https://r.example.com/rss' });
    await repos.articles.upsertMany([
      {
        feedId: feed.id,
        guid: 'g1',
        title: 'SurvivingArticle',
        url: 'https://r.example.com/1',
        publishedAt: new Date(),
      },
    ]);

    const res = await getPage(base, '/', cookie);
    assert.equal(res.status, 200, 'getRates の失敗でダッシュボードを壊さない');
    const html = await res.text();
    assert.match(html, /今日のトレンド/);
    assert.match(html, /SurvivingArticle/, '記事表示など為替以外の機能は無事');
    assert.ok(!html.includes('USD/JPY'), '取得失敗時は為替を表示しない');
    assert.ok(!html.includes('rates backend down'), 'エラーメッセージを画面に漏らさない');
  } finally {
    await close();
  }
});
