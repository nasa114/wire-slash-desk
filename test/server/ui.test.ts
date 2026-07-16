import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../src/server/app.ts';
import { createMemoryRepositories } from '../../src/repo/memory/index.ts';
import type { Repositories } from '../../src/domain/repositories.ts';

const UI_PASSWORD = 'ui-test-password';

async function startApp(opts: { uiPassword?: string } = {}): Promise<{
  repos: Repositories;
  base: string;
  close: () => Promise<void>;
}> {
  const repos = createMemoryRepositories();
  const app: Server = createApp({
    repos,
    runCollect: async () => ({}),
    mcpBearerToken: 'mcp-token',
    collectorToken: 'collector-token',
    cacheFulltext: false,
    ...opts,
  });
  await new Promise<void>((resolve) => app.listen(0, resolve));
  const { port } = app.address() as AddressInfo;
  return {
    repos,
    base: `http://localhost:${port}`,
    close: () => new Promise((resolve) => app.close(() => resolve())),
  };
}

function basicAuth(password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`user:${password}`).toString('base64')}` };
}

async function seed(repos: Repositories): Promise<void> {
  const feed = await repos.feeds.create({ name: 'Feed <One>', feedUrl: 'https://one.example.com/rss' });
  await repos.articles.upsertMany([
    {
      feedId: feed.id,
      guid: 'g1',
      title: 'PostgreSQL 17 Released',
      url: 'https://one.example.com/pg17',
      publishedAt: new Date('2026-07-15T10:00:00Z'),
    },
    {
      feedId: feed.id,
      guid: 'g2',
      title: '<script>alert(1)</script> injection attempt',
      url: 'https://one.example.com/xss',
      publishedAt: new Date('2026-07-14T10:00:00Z'),
    },
  ]);
}

test('UI: uiPassword 未設定なら /ui は 404(無効化)', async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/ui`);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('UI: 認証なしは 401 + WWW-Authenticate: Basic', async () => {
  const { base, close } = await startApp({ uiPassword: UI_PASSWORD });
  try {
    const res = await fetch(`${base}/ui`);
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /^Basic /);
  } finally {
    await close();
  }
});

test('UI: 誤パスワードは 401', async () => {
  const { base, close } = await startApp({ uiPassword: UI_PASSWORD });
  try {
    const res = await fetch(`${base}/ui`, { headers: basicAuth('wrong') });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test('UI: 正しいパスワードで記事一覧ページ(/ui/articles)が返る', async () => {
  const { repos, base, close } = await startApp({ uiPassword: UI_PASSWORD });
  try {
    await seed(repos);
    const res = await fetch(`${base}/ui/articles`, { headers: basicAuth(UI_PASSWORD) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /PostgreSQL 17 Released/);
    assert.match(html, /https:\/\/one\.example\.com\/pg17/);
  } finally {
    await close();
  }
});

test('UI: タイトル・フィード名は HTML エスケープされる(XSS対策)', async () => {
  const { repos, base, close } = await startApp({ uiPassword: UI_PASSWORD });
  try {
    await seed(repos);
    const html = await (await fetch(`${base}/ui/articles`, { headers: basicAuth(UI_PASSWORD) })).text();
    assert.ok(!html.includes('<script>alert(1)</script>'), '生の script タグが出力されてはならない');
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    const feedsHtml = await (
      await fetch(`${base}/ui/feeds`, { headers: basicAuth(UI_PASSWORD) })
    ).text();
    assert.match(feedsHtml, /Feed &lt;One&gt;/);
  } finally {
    await close();
  }
});

test('UI: ?q= でタイトル検索できる', async () => {
  const { repos, base, close } = await startApp({ uiPassword: UI_PASSWORD });
  try {
    await seed(repos);
    const html = await (
      await fetch(`${base}/ui?q=postgresql`, { headers: basicAuth(UI_PASSWORD) })
    ).text();
    assert.match(html, /PostgreSQL 17 Released/);
    assert.ok(!html.includes('injection attempt'));
  } finally {
    await close();
  }
});

test('UI: ?date= でその JST 日の記事に絞れる', async () => {
  const { repos, base, close } = await startApp({ uiPassword: UI_PASSWORD });
  try {
    await seed(repos);
    const html = await (
      await fetch(`${base}/ui?date=2026-07-14`, { headers: basicAuth(UI_PASSWORD) })
    ).text();
    assert.match(html, /injection attempt/);
    assert.ok(!html.includes('PostgreSQL 17 Released'));
    const bad = await fetch(`${base}/ui?date=not-a-date`, { headers: basicAuth(UI_PASSWORD) });
    assert.equal(bad.status, 400);
  } finally {
    await close();
  }
});

test('UI: /ui/feeds にフィード一覧とフラグが表示される', async () => {
  const { repos, base, close } = await startApp({ uiPassword: UI_PASSWORD });
  try {
    await seed(repos);
    const res = await fetch(`${base}/ui/feeds`, { headers: basicAuth(UI_PASSWORD) });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Feed &lt;One&gt;/);
    assert.match(html, /https:\/\/one\.example\.com\/rss/);
  } finally {
    await close();
  }
});

test('UI: 危険な URL スキームはリンク化せずテキスト表示(javascript:/data:/パース不能)', async () => {
  const { repos, base, close } = await startApp({ uiPassword: UI_PASSWORD });
  try {
    const feed = await repos.feeds.create({
      name: 'Evil',
      feedUrl: 'https://evil.example.com/rss',
    });
    await repos.articles.upsertMany([
      {
        feedId: feed.id,
        guid: 'js',
        title: 'EvilJavascriptArticle',
        url: 'javascript:alert(1)',
        publishedAt: new Date('2026-07-15T10:00:00Z'),
      },
      {
        feedId: feed.id,
        guid: 'data',
        title: 'EvilDataArticle',
        url: 'data:text/html,<script>alert(2)</script>',
        publishedAt: new Date('2026-07-15T09:00:00Z'),
      },
      {
        feedId: feed.id,
        guid: 'bad',
        title: 'EvilUnparseableArticle',
        url: 'not a valid url',
        publishedAt: new Date('2026-07-15T08:00:00Z'),
      },
      {
        feedId: feed.id,
        guid: 'ok',
        title: 'GoodHttpsArticle',
        url: 'https://evil.example.com/ok',
        publishedAt: new Date('2026-07-15T07:00:00Z'),
      },
    ]);
    const html = await (await fetch(`${base}/ui/articles`, { headers: basicAuth(UI_PASSWORD) })).text();
    // 危険スキームは href に現れない
    assert.ok(!html.includes('href="javascript:'), 'javascript: が href に現れてはならない');
    assert.ok(!html.includes('javascript:alert(1)'), 'javascript: URL 文字列が出力されてはならない');
    assert.ok(!html.includes('href="data:'), 'data: が href に現れてはならない');
    assert.ok(!/href="not a valid url"/.test(html), 'パース不能 URL が href に現れてはならない');
    // タイトルは表示される(リンクでなくてもテキストとして)
    assert.match(html, /EvilJavascriptArticle/);
    assert.match(html, /EvilDataArticle/);
    assert.match(html, /EvilUnparseableArticle/);
    // 正常な https はリンク化される
    assert.match(html, /href="https:\/\/evil\.example\.com\/ok"/);
  } finally {
    await close();
  }
});

test('UI: date は実在日のみ受理(2026-02-31 → 400, 2026-02-28 → 200)', async () => {
  const { base, close } = await startApp({ uiPassword: UI_PASSWORD });
  try {
    const bad = await fetch(`${base}/ui?date=2026-02-31`, { headers: basicAuth(UI_PASSWORD) });
    assert.equal(bad.status, 400);
    const bad2 = await fetch(`${base}/ui?date=2026-99-99`, { headers: basicAuth(UI_PASSWORD) });
    assert.equal(bad2.status, 400);
    const ok = await fetch(`${base}/ui?date=2026-02-28`, { headers: basicAuth(UI_PASSWORD) });
    assert.equal(ok.status, 200);
  } finally {
    await close();
  }
});

test('UI: q+feed 併用は指定フィードの記事のみ表示(回帰)', async () => {
  const { repos, base, close } = await startApp({ uiPassword: UI_PASSWORD });
  try {
    const feed1 = await repos.feeds.create({ name: 'Feed1', feedUrl: 'https://f1.example.com/rss' });
    const feed2 = await repos.feeds.create({ name: 'Feed2', feedUrl: 'https://f2.example.com/rss' });
    await repos.articles.upsertMany([
      {
        feedId: feed1.id,
        guid: 'a',
        title: 'Kubernetes on feed1',
        url: 'https://f1.example.com/a',
        publishedAt: new Date('2026-07-15T10:00:00Z'),
      },
      {
        feedId: feed2.id,
        guid: 'b',
        title: 'Kubernetes on feed2',
        url: 'https://f2.example.com/b',
        publishedAt: new Date('2026-07-15T09:00:00Z'),
      },
    ]);
    const html = await (
      await fetch(`${base}/ui?q=kubernetes&feed=${feed1.id}`, { headers: basicAuth(UI_PASSWORD) })
    ).text();
    assert.match(html, /Kubernetes on feed1/);
    assert.ok(!html.includes('Kubernetes on feed2'), 'feed1 指定時に feed2 の記事が出てはならない');
  } finally {
    await close();
  }
});

test('UI: 属性を破るタイトル・クエリ再表示・不正 feed の防御(XSS拡充)', async () => {
  const { repos, base, close } = await startApp({ uiPassword: UI_PASSWORD });
  try {
    const feed = await repos.feeds.create({
      name: 'AttrFeed',
      feedUrl: 'https://attr.example.com/rss',
    });
    await repos.articles.upsertMany([
      {
        feedId: feed.id,
        guid: 'attr',
        title: `break"'><&marker`,
        url: 'https://attr.example.com/x',
        publishedAt: new Date('2026-07-15T10:00:00Z'),
      },
    ]);
    // 属性を破る文字を含むタイトルがエスケープされる
    const html = await (
      await fetch(`${base}/ui/articles`, { headers: basicAuth(UI_PASSWORD) })
    ).text();
    assert.ok(!html.includes(`break"'><&marker`), '生の危険文字列が出力されてはならない');
    assert.match(html, /break&quot;&#39;&gt;&lt;&amp;marker/);
    // クエリ再表示のエスケープ(value 属性を破らない)
    const qHtml = await (
      await fetch(`${base}/ui?q=${encodeURIComponent('"><script>')}`, {
        headers: basicAuth(UI_PASSWORD),
      })
    ).text();
    assert.ok(!qHtml.includes('"><script>'), 'クエリの生 script が value を破ってはならない');
    assert.match(qHtml, /value="&quot;&gt;&lt;script&gt;"/);
    // 不正 UUID の feed は 400
    const bad = await fetch(`${base}/ui?feed=not-a-uuid`, { headers: basicAuth(UI_PASSWORD) });
    assert.equal(bad.status, 400);
  } finally {
    await close();
  }
});

test('UI: ダッシュボードにトレンド枠・今朝更新・フィード状態が表示される', async () => {
  const { repos, base, close } = await startApp({ uiPassword: UI_PASSWORD });
  try {
    await seed(repos);
    const html = await (await fetch(`${base}/ui`, { headers: basicAuth(UI_PASSWORD) })).text();
    assert.match(html, /今日のトレンド/);
    assert.match(html, /今朝更新された記事/);
    assert.match(html, /フィードの状態/);
    assert.match(html, /href="\/ui\/articles"/, '記事一覧ページへの導線があること');
  } finally {
    await close();
  }
});

test('UI: 表示時刻は日本時間(JST)', async () => {
  const { repos, base, close } = await startApp({ uiPassword: UI_PASSWORD });
  try {
    const feed = await repos.feeds.create({ name: 'JST', feedUrl: 'https://jst.example.com/rss' });
    // 2026-07-14T20:30:00Z = 2026-07-15 05:30 JST
    await repos.articles.upsertMany([
      {
        feedId: feed.id,
        guid: 'jst1',
        title: 'JstBoundaryArticle',
        url: 'https://jst.example.com/1',
        publishedAt: new Date('2026-07-14T20:30:00Z'),
      },
    ]);
    const html = await (
      await fetch(`${base}/ui/articles`, { headers: basicAuth(UI_PASSWORD) })
    ).text();
    assert.match(html, /2026-07-15 05:30/, '公開日時は JST で表示される');
    assert.ok(!html.includes('2026-07-14 20:30'), 'UTC のままの時刻を表示しない');
  } finally {
    await close();
  }
});

test('UI: ?date= は JST の1日として解釈される(UTC跨ぎ境界)', async () => {
  const { repos, base, close } = await startApp({ uiPassword: UI_PASSWORD });
  try {
    const feed = await repos.feeds.create({ name: 'JST', feedUrl: 'https://jst.example.com/rss' });
    await repos.articles.upsertMany([
      // 2026-07-14T20:30:00Z = 07-15 05:30 JST → JST では 7/15 の記事
      {
        feedId: feed.id,
        guid: 'b1',
        title: 'LateNightUtcArticle',
        url: 'https://jst.example.com/b1',
        publishedAt: new Date('2026-07-14T20:30:00Z'),
      },
      // 2026-07-15T16:00:00Z = 07-16 01:00 JST → JST では 7/16 の記事
      {
        feedId: feed.id,
        guid: 'b2',
        title: 'NextJstDayArticle',
        url: 'https://jst.example.com/b2',
        publishedAt: new Date('2026-07-15T16:00:00Z'),
      },
    ]);
    const day15 = await (
      await fetch(`${base}/ui/articles?date=2026-07-15`, { headers: basicAuth(UI_PASSWORD) })
    ).text();
    assert.match(day15, /LateNightUtcArticle/, 'UTC 前日夜の記事は JST 当日に含まれる');
    assert.ok(!day15.includes('NextJstDayArticle'), 'JST 翌日の記事は含まれない');
    const day16 = await (
      await fetch(`${base}/ui/articles?date=2026-07-16`, { headers: basicAuth(UI_PASSWORD) })
    ).text();
    assert.match(day16, /NextJstDayArticle/);
  } finally {
    await close();
  }
});

test('UI: /ui/articles の q / feed フィルタが機能する', async () => {
  const { repos, base, close } = await startApp({ uiPassword: UI_PASSWORD });
  try {
    await seed(repos);
    const q = await (
      await fetch(`${base}/ui/articles?q=postgresql`, { headers: basicAuth(UI_PASSWORD) })
    ).text();
    assert.match(q, /PostgreSQL 17 Released/);
    assert.ok(!q.includes('injection attempt'));
    const bad = await fetch(`${base}/ui/articles?date=2026-02-31`, {
      headers: basicAuth(UI_PASSWORD),
    });
    assert.equal(bad.status, 400);
  } finally {
    await close();
  }
});

test('UI: MCP と collect の認証は UI パスワードでは通らない(系統分離)', async () => {
  const { base, close } = await startApp({ uiPassword: UI_PASSWORD });
  try {
    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...basicAuth(UI_PASSWORD), 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(mcp.status, 401);
    const collect = await fetch(`${base}/internal/collect`, {
      method: 'POST',
      headers: basicAuth(UI_PASSWORD),
    });
    assert.equal(collect.status, 401);
  } finally {
    await close();
  }
});
