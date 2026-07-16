import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { collectDueFeeds } from '../../src/collector/collector.ts';
import { createMemoryRepositories } from '../../src/repo/memory/index.ts';
import { createFakeFetch } from './fake-fetch.ts';
import { RSS_FIXTURE, ATOM_FIXTURE, xmlResponse, seedFeed } from './helpers.ts';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

test('不変条件: 本文入りRSSを収集しても articles.content は常に null', async () => {
  const repos = createMemoryRepositories();
  await seedFeed(repos);
  const fetchFn = createFakeFetch(() => xmlResponse(RSS_FIXTURE));

  const result = await collectDueFeeds({ repos, fetchFn, now: () => new Date('2026-07-16T00:00:00Z') });

  assert.equal(result.feeds[0]?.status, 'ok');
  assert.equal(result.totalInserted, 2); // 3件中1件は link 無しでスキップ

  const articles = await repos.articles.listRecent();
  assert.equal(articles.length, 2);
  for (const article of articles) {
    assert.equal(article.content, null);
  }
});

test('不変条件: Atomフィードでも articles.content は常に null', async () => {
  const repos = createMemoryRepositories();
  await seedFeed(repos, { feedUrl: 'https://example.com/atom.xml' });
  const fetchFn = createFakeFetch(() => xmlResponse(ATOM_FIXTURE));

  const result = await collectDueFeeds({ repos, fetchFn, now: () => new Date('2026-07-16T00:00:00Z') });

  assert.equal(result.feeds[0]?.status, 'ok');
  assert.equal(result.totalInserted, 2);

  const articles = await repos.articles.listRecent();
  assert.equal(articles.length, 2);
  for (const article of articles) {
    assert.equal(article.content, null);
  }
});

test('title/url/publishedAt/guid が正しくマップされる', async () => {
  const repos = createMemoryRepositories();
  await seedFeed(repos);
  const fetchFn = createFakeFetch(() => xmlResponse(RSS_FIXTURE));

  await collectDueFeeds({ repos, fetchFn, now: () => new Date('2026-07-16T00:00:00Z') });

  const articles = await repos.articles.listRecent();
  const first = articles.find((a) => a.guid === 'post-1-guid');
  assert.ok(first, 'guid つきアイテムがそのまま guid として使われる');
  assert.equal(first?.title, 'First Post');
  assert.equal(first?.url, 'https://example.com/posts/1');
  assert.equal(first?.publishedAt?.toISOString(), new Date('Mon, 15 Jul 2026 10:00:00 GMT').toISOString());
  assert.equal(first?.lang, 'en-us');
});

test('guid 欠落アイテムは sha256(url) の hex が guid になる', async () => {
  const repos = createMemoryRepositories();
  await seedFeed(repos);
  const fetchFn = createFakeFetch(() => xmlResponse(RSS_FIXTURE));

  await collectDueFeeds({ repos, fetchFn, now: () => new Date('2026-07-16T00:00:00Z') });

  const articles = await repos.articles.listRecent();
  const expectedGuid = sha256Hex('https://example.com/posts/2');
  const second = articles.find((a) => a.url === 'https://example.com/posts/2');
  assert.ok(second, 'guid の無いアイテムも url があれば保存される');
  assert.equal(second?.guid, expectedGuid);
});

test('link の無いアイテムはスキップされる', async () => {
  const repos = createMemoryRepositories();
  await seedFeed(repos);
  const fetchFn = createFakeFetch(() => xmlResponse(RSS_FIXTURE));

  await collectDueFeeds({ repos, fetchFn, now: () => new Date('2026-07-16T00:00:00Z') });

  const articles = await repos.articles.listRecent();
  assert.equal(
    articles.some((a) => a.title === 'No Link Item'),
    false,
  );
});

test('2回目の実行で etag が If-None-Match として送信され、304 応答では upsert されない', async () => {
  const repos = createMemoryRepositories();
  const feed = await seedFeed(repos);
  let current = new Date('2026-07-16T00:00:00Z');

  const fetchFn = createFakeFetch((_url, _headers, callIndex) => {
    if (callIndex === 0) {
      return xmlResponse(RSS_FIXTURE, {
        headers: {
          'content-type': 'application/rss+xml',
          etag: 'W/"v1"',
          'last-modified': 'Wed, 15 Jul 2026 09:00:00 GMT',
        },
      });
    }
    return new Response(null, { status: 304 });
  });

  const first = await collectDueFeeds({ repos, fetchFn, now: () => current });
  assert.equal(first.feeds[0]?.status, 'ok');
  assert.equal(first.totalInserted, 2);

  const storedFeed = await repos.feeds.getById(feed.id);
  assert.equal(storedFeed?.etag, 'W/"v1"');

  // 15分インターバルなので due にするために時刻を進める
  current = new Date(current.getTime() + 16 * 60_000);
  const second = await collectDueFeeds({ repos, fetchFn, now: () => current });

  assert.equal(fetchFn.calls.length, 2);
  assert.equal(fetchFn.calls[1]?.headers['If-None-Match'], 'W/"v1"');
  assert.equal(fetchFn.calls[1]?.headers['If-Modified-Since'], 'Wed, 15 Jul 2026 09:00:00 GMT');

  assert.equal(second.feeds[0]?.status, 'not_modified');
  assert.equal(second.totalInserted, 0);
  assert.equal(second.totalSkipped, 0);

  const articles = await repos.articles.listRecent();
  assert.equal(articles.length, 2, '304 応答では新規 upsert が発生しない');

  const refetched = await repos.feeds.getById(feed.id);
  assert.equal(refetched?.lastFetchedAt?.getTime(), current.getTime(), 'lastFetchedAt のみ更新される');
});

test('同一フィードを再収集すると重複記事は skipped になる', async () => {
  const repos = createMemoryRepositories();
  await seedFeed(repos);
  let current = new Date('2026-07-16T00:00:00Z');
  const fetchFn = createFakeFetch(() => xmlResponse(RSS_FIXTURE));

  const first = await collectDueFeeds({ repos, fetchFn, now: () => current });
  assert.equal(first.totalInserted, 2);
  assert.equal(first.totalSkipped, 0);

  current = new Date(current.getTime() + 16 * 60_000);
  const second = await collectDueFeeds({ repos, fetchFn, now: () => current });

  assert.equal(second.feeds[0]?.status, 'ok');
  assert.equal(second.totalInserted, 0);
  assert.equal(second.totalSkipped, 2);

  const articles = await repos.articles.listRecent();
  assert.equal(articles.length, 2, '重複は保存されない');
});

test('1フィードが 500 応答でも他フィードは収集される(status=error の分離)', async () => {
  const repos = createMemoryRepositories();
  const badFeed = await seedFeed(repos, { feedUrl: 'https://bad.example.com/rss.xml' });
  const goodFeed = await seedFeed(repos, { feedUrl: 'https://good.example.com/rss.xml' });

  const fetchFn = createFakeFetch((url) => {
    if (url === badFeed.feedUrl) {
      return new Response('internal error', { status: 500 });
    }
    if (url === goodFeed.feedUrl) {
      return xmlResponse(RSS_FIXTURE);
    }
    throw new Error(`unexpected url: ${url}`);
  });

  const result = await collectDueFeeds({ repos, fetchFn, now: () => new Date('2026-07-16T00:00:00Z') });

  const badResult = result.feeds.find((f) => f.feedId === badFeed.id);
  const goodResult = result.feeds.find((f) => f.feedId === goodFeed.id);

  assert.equal(badResult?.status, 'error');
  assert.ok(badResult?.error && badResult.error.length > 0);
  assert.equal(goodResult?.status, 'ok');
  assert.equal(goodResult?.inserted, 2);

  const articles = await repos.articles.listRecent();
  assert.equal(articles.length, 2, 'good フィードの記事のみ保存される');
});

test('例外(タイムアウト等)を投げるフィードも他フィードの収集を妨げない', async () => {
  const repos = createMemoryRepositories();
  const throwingFeed = await seedFeed(repos, { feedUrl: 'https://throws.example.com/rss.xml' });
  const goodFeed = await seedFeed(repos, { feedUrl: 'https://good2.example.com/rss.xml' });

  const fetchFn = createFakeFetch((url) => {
    if (url === throwingFeed.feedUrl) {
      throw new Error('network down');
    }
    return xmlResponse(RSS_FIXTURE);
  });

  const result = await collectDueFeeds({ repos, fetchFn, now: () => new Date('2026-07-16T00:00:00Z') });

  const throwingResult = result.feeds.find((f) => f.feedId === throwingFeed.id);
  const goodResult = result.feeds.find((f) => f.feedId === goodFeed.id);

  assert.equal(throwingResult?.status, 'error');
  assert.equal(throwingResult?.error, 'network down');
  assert.equal(goodResult?.status, 'ok');
});

test('due でないフィード(直近取得済み・disabled)は fetch されない', async () => {
  const repos = createMemoryRepositories();
  const now = new Date('2026-07-16T12:00:00Z');

  const fresh = await seedFeed(repos, { feedUrl: 'https://fresh.example.com/rss.xml', fetchIntervalMinutes: 60 });
  await repos.feeds.markFetched(fresh.id, new Date(now.getTime() - 10 * 60_000));

  await seedFeed(repos, { feedUrl: 'https://disabled.example.com/rss.xml', enabled: false });

  const due = await seedFeed(repos, { feedUrl: 'https://due.example.com/rss.xml', fetchIntervalMinutes: 15 });

  const fetchFn = createFakeFetch(() => xmlResponse(RSS_FIXTURE));

  const result = await collectDueFeeds({ repos, fetchFn, now: () => now });

  assert.equal(result.feeds.length, 1);
  assert.equal(result.feeds[0]?.feedId, due.id);
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(fetchFn.calls[0]?.url, 'https://due.example.com/rss.xml');
});

test('User-Agent が既定値で送信される', async () => {
  const repos = createMemoryRepositories();
  await seedFeed(repos);
  const fetchFn = createFakeFetch(() => xmlResponse(RSS_FIXTURE));

  await collectDueFeeds({ repos, fetchFn, now: () => new Date('2026-07-16T00:00:00Z') });

  assert.equal(
    fetchFn.calls[0]?.headers['User-Agent'],
    'personal-rss-reader/0.1 (+https://github.com/example/personal-rss-reader)',
  );
});
