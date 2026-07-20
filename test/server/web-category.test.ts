import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../src/server/app.ts';
import { createMemoryRepositories } from '../../src/repo/memory/index.ts';
import type { Repositories } from '../../src/domain/repositories.ts';

/**
 * フィードごとのカテゴリ機能の Web UI テスト。
 * セットアップは test/server/web.test.ts と同じ手法(createApp + memory repos + フォームログイン)。
 */

const ADMIN_USER = 'admin';
const ADMIN_PASSWORD = 'test-password-123';

interface TestApp {
  repos: Repositories;
  base: string;
  close: () => Promise<void>;
}

async function startApp(): Promise<TestApp> {
  const repos = createMemoryRepositories();
  const app: Server = createApp({
    repos,
    runCollect: async () => ({}),
    mcpBearerToken: 'mcp-token',
    collectorToken: 'collector-token',
    cacheFulltext: false,
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

/** ログインしてセッション Cookie(`session=...`)を返す。 */
async function startLoggedIn(): Promise<TestApp & { cookie: string }> {
  const app = await startApp();
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

/** 必須フィールドを埋めたフィード追加/編集フォームボディ。 */
function feedForm(over: Record<string, string> = {}): Record<string, string> {
  return {
    name: 'Feed X',
    feed_url: 'https://x.example.com/rss',
    fetch_interval_minutes: '60',
    enabled: 'on',
    ...over,
  };
}

/* ------------------------------------------------------ feeds フォーム */

test('category: フォームから指定して追加できる(前後空白は trim)', async () => {
  const { base, repos, cookie, close } = await startLoggedIn();
  try {
    const res = await postForm(base, '/feeds', feedForm({ category: '  技術  ' }), { cookie });
    assert.equal(res.status, 303);
    const feeds = await repos.feeds.list();
    assert.equal(feeds.length, 1);
    assert.equal(feeds[0]!.category, '技術', '前後空白は trim して保存される');
  } finally {
    await close();
  }
});

test('category: 未指定・空文字は null として保存される', async () => {
  const { base, repos, cookie, close } = await startLoggedIn();
  try {
    // フィールドなし
    const noField = await postForm(
      base,
      '/feeds',
      feedForm({ name: 'NoField', feed_url: 'https://nofield.example.com/rss' }),
      { cookie },
    );
    assert.equal(noField.status, 303);
    // 空文字
    const emptyStr = await postForm(
      base,
      '/feeds',
      feedForm({ name: 'Empty', feed_url: 'https://empty.example.com/rss', category: '' }),
      { cookie },
    );
    assert.equal(emptyStr.status, 303);
    // 空白のみ(trim すると空)
    const blank = await postForm(
      base,
      '/feeds',
      feedForm({ name: 'Blank', feed_url: 'https://blank.example.com/rss', category: '   ' }),
      { cookie },
    );
    assert.equal(blank.status, 303);

    for (const feed of await repos.feeds.list()) {
      assert.equal(feed.category, null, `${feed.name} の category は null`);
    }
  } finally {
    await close();
  }
});

test('category: 100文字は許可・101文字は 400 でフォーム再表示', async () => {
  const { base, repos, cookie, close } = await startLoggedIn();
  try {
    const tooLong = await postForm(base, '/feeds', feedForm({ category: 'x'.repeat(101) }), { cookie });
    assert.equal(tooLong.status, 400, '101文字は 400');
    assert.match(await tooLong.text(), /role="alert"/, 'バリデーションエラーはフォーム再表示で示す');
    assert.equal((await repos.feeds.list()).length, 0, 'フィードは作成されていない');

    const maxOk = await postForm(base, '/feeds', feedForm({ category: 'x'.repeat(100) }), { cookie });
    assert.equal(maxOk.status, 303, '100文字ちょうどは許可');
    assert.equal((await repos.feeds.list())[0]?.category, 'x'.repeat(100));
  } finally {
    await close();
  }
});

test('category: 編集フォームで変更・クリアできる', async () => {
  const { base, repos, cookie, close } = await startLoggedIn();
  try {
    const feed = await repos.feeds.create({ name: 'Old', feedUrl: 'https://old.example.com/rss' });

    const set = await postForm(
      base,
      `/feeds/${feed.id}`,
      feedForm({ name: 'Old', feed_url: 'https://old.example.com/rss', category: '技術' }),
      { cookie },
    );
    assert.equal(set.status, 303);
    assert.equal((await repos.feeds.getById(feed.id))?.category, '技術');

    // 空文字でクリア
    const clear = await postForm(
      base,
      `/feeds/${feed.id}`,
      feedForm({ name: 'Old', feed_url: 'https://old.example.com/rss', category: '' }),
      { cookie },
    );
    assert.equal(clear.status, 303);
    assert.equal((await repos.feeds.getById(feed.id))?.category, null, '空文字は null にクリア');
  } finally {
    await close();
  }
});

test('category: フィード一覧に表示され、escapeHtml される', async () => {
  const { base, repos, cookie, close } = await startLoggedIn();
  try {
    await repos.feeds.create({
      name: 'TechFeed',
      feedUrl: 'https://tech.example.com/rss',
      category: '技術ニュース',
    });
    // XSS を狙うカテゴリ名はフォーム経由で登録(登録経路でも素通りしないこと)
    const evil = await postForm(
      base,
      '/feeds',
      feedForm({
        name: 'EvilFeed',
        feed_url: 'https://evil.example.com/rss',
        category: '<script>alert(9)</script>',
      }),
      { cookie },
    );
    assert.equal(evil.status, 303);

    const html = await (await getPage(base, '/feeds', cookie)).text();
    assert.match(html, /技術ニュース/, '登録したカテゴリが一覧に表示される');
    assert.ok(!html.includes('<script>alert(9)</script>'), '生の script タグが出力されてはならない');
    assert.match(html, /&lt;script&gt;alert\(9\)&lt;\/script&gt;/, 'エスケープ済みで出力される');
  } finally {
    await close();
  }
});

/* ------------------------------------------------- articles 絞り込み */

test('category: /articles?category= でそのカテゴリのフィードの記事だけが表示される', async () => {
  const { base, repos, cookie, close } = await startLoggedIn();
  try {
    const tech = await repos.feeds.create({
      name: 'Tech',
      feedUrl: 'https://tech.example.com/rss',
      category: '技術',
    });
    const news = await repos.feeds.create({
      name: 'News',
      feedUrl: 'https://news.example.com/rss',
      category: 'ニュース',
    });
    const nocat = await repos.feeds.create({ name: 'NoCat', feedUrl: 'https://nocat.example.com/rss' });
    await repos.articles.upsertMany([
      { feedId: tech.id, guid: 't1', title: 'TechOnlyArticle', url: 'https://tech.example.com/1', publishedAt: new Date('2026-07-15T10:00:00Z') },
      { feedId: news.id, guid: 'n1', title: 'NewsOnlyArticle', url: 'https://news.example.com/1', publishedAt: new Date('2026-07-15T09:00:00Z') },
      { feedId: nocat.id, guid: 'c1', title: 'NoCatArticle', url: 'https://nocat.example.com/1', publishedAt: new Date('2026-07-15T08:00:00Z') },
    ]);

    const res = await getPage(base, `/articles?category=${encodeURIComponent('技術')}`, cookie);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /TechOnlyArticle/);
    assert.ok(!html.includes('NewsOnlyArticle'), '他カテゴリのフィードの記事は出ない');
    assert.ok(!html.includes('NoCatArticle'), 'カテゴリなしフィードの記事は出ない');
  } finally {
    await close();
  }
});

test('category: q / date / feed と組み合わせて絞り込める', async () => {
  const { base, repos, cookie, close } = await startLoggedIn();
  try {
    const techA = await repos.feeds.create({
      name: 'TechA',
      feedUrl: 'https://tech-a.example.com/rss',
      category: '技術',
    });
    const techB = await repos.feeds.create({
      name: 'TechB',
      feedUrl: 'https://tech-b.example.com/rss',
      category: '技術',
    });
    const news = await repos.feeds.create({
      name: 'News',
      feedUrl: 'https://news.example.com/rss',
      category: 'ニュース',
    });
    await repos.articles.upsertMany([
      // 2026-07-15T10:00Z = 2026-07-15 19:00 JST
      { feedId: techA.id, guid: 'a1', title: 'Kubernetes techA', url: 'https://tech-a.example.com/1', publishedAt: new Date('2026-07-15T10:00:00Z') },
      { feedId: techA.id, guid: 'a2', title: 'OldTechArticle', url: 'https://tech-a.example.com/2', publishedAt: new Date('2026-07-10T10:00:00Z') },
      { feedId: techB.id, guid: 'b1', title: 'Kubernetes techB', url: 'https://tech-b.example.com/1', publishedAt: new Date('2026-07-15T09:00:00Z') },
      { feedId: news.id, guid: 'n1', title: 'Kubernetes news', url: 'https://news.example.com/1', publishedAt: new Date('2026-07-15T08:00:00Z') },
    ]);
    const cat = encodeURIComponent('技術');

    // q + category
    const byQ = await (await getPage(base, `/articles?q=kubernetes&category=${cat}`, cookie)).text();
    assert.match(byQ, /Kubernetes techA/);
    assert.match(byQ, /Kubernetes techB/);
    assert.ok(!byQ.includes('Kubernetes news'), 'q 併用でも他カテゴリは出ない');

    // date + category(JST の1日)
    const byDate = await (await getPage(base, `/articles?date=2026-07-15&category=${cat}`, cookie)).text();
    assert.match(byDate, /Kubernetes techA/);
    assert.match(byDate, /Kubernetes techB/);
    assert.ok(!byDate.includes('Kubernetes news'), 'date 併用でも他カテゴリは出ない');
    assert.ok(!byDate.includes('OldTechArticle'), '別日の記事は出ない');

    // feed + category
    const byFeed = await (await getPage(base, `/articles?feed=${techA.id}&category=${cat}`, cookie)).text();
    assert.match(byFeed, /Kubernetes techA/);
    assert.ok(!byFeed.includes('Kubernetes techB'), 'feed 併用では指定フィードの記事のみ');
    assert.ok(!byFeed.includes('Kubernetes news'));
  } finally {
    await close();
  }
});

test('category: クエリが101文字以上は 400・エスケープ済みで出力される', async () => {
  const { base, repos, cookie, close } = await startLoggedIn();
  try {
    const tooLong = await getPage(base, `/articles?category=${'x'.repeat(101)}`, cookie);
    assert.equal(tooLong.status, 400, '101文字は 400');
    const maxOk = await getPage(base, `/articles?category=${'x'.repeat(100)}`, cookie);
    assert.equal(maxOk.status, 200, '100文字は許可');

    // 悪意あるカテゴリ名を登録した上で、そのカテゴリで絞り込んでも生の script は出ない
    await repos.feeds.create({
      name: 'Evil',
      feedUrl: 'https://evil.example.com/rss',
      category: '<script>alert(9)</script>',
    });
    const res = await getPage(
      base,
      `/articles?category=${encodeURIComponent('<script>alert(9)</script>')}`,
      cookie,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes('<script>alert(9)</script>'), '生の script タグが出力されてはならない');
  } finally {
    await close();
  }
});
