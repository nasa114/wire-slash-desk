import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectDueFeeds } from '../../src/collector/collector.ts';
import { createMemoryRepositories } from '../../src/repo/memory/index.ts';
import { createFakeFetch } from './fake-fetch.ts';
import { RSS_FIXTURE, xmlResponse, seedFeed } from './helpers.ts';

test('同時実行数が concurrency オプションを超えない', async () => {
  const repos = createMemoryRepositories();
  const FEED_COUNT = 6;
  const CONCURRENCY = 2;

  for (let i = 0; i < FEED_COUNT; i += 1) {
    await seedFeed(repos, { feedUrl: `https://feed${i}.example.com/rss.xml` });
  }

  let inFlight = 0;
  let maxInFlight = 0;
  const fetchFn = createFakeFetch(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight -= 1;
    return xmlResponse(RSS_FIXTURE);
  });

  const result = await collectDueFeeds({
    repos,
    fetchFn,
    now: () => new Date('2026-07-16T00:00:00Z'),
    concurrency: CONCURRENCY,
  });

  assert.equal(result.feeds.length, FEED_COUNT);
  assert.equal(fetchFn.calls.length, FEED_COUNT);
  assert.ok(maxInFlight <= CONCURRENCY, `observed max in-flight ${maxInFlight} must be <= ${CONCURRENCY}`);
  assert.equal(maxInFlight, CONCURRENCY, '並列度は concurrency の上限まで使われるはず');
});

test('既定の concurrency は 4', async () => {
  const repos = createMemoryRepositories();
  const FEED_COUNT = 8;

  for (let i = 0; i < FEED_COUNT; i += 1) {
    await seedFeed(repos, { feedUrl: `https://default${i}.example.com/rss.xml` });
  }

  let inFlight = 0;
  let maxInFlight = 0;
  const fetchFn = createFakeFetch(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    return xmlResponse(RSS_FIXTURE);
  });

  await collectDueFeeds({ repos, fetchFn, now: () => new Date('2026-07-16T00:00:00Z') });

  assert.ok(maxInFlight <= 4, `observed max in-flight ${maxInFlight} must be <= 4`);
  assert.equal(maxInFlight, 4);
});
