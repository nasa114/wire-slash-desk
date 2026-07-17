import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectDueFeeds } from '../../src/collector/collector.ts';
import { createMemoryRepositories } from '../../src/repo/memory/index.ts';
import type { LookupFn } from '../../src/server/ssrf.ts';
import { createFakeFetch } from './fake-fetch.ts';
import { RSS_FIXTURE, xmlResponse, seedFeed } from './helpers.ts';

/**
 * Collector の SSRF ガード(fetch_article_content と同等の防御を feed 取得にも適用)。
 * 設計書 §6 / docs/004_KnownLimitations.md §1 の方針を collector 経路へ拡張する。
 *
 * 攻撃モデル: 登録済みフィード(信頼していた公開フィードを含む)の feed_url が
 * プライベート IP を指す/プライベート IP へリダイレクトする場合でも、collector が
 * 内部ネットワークへ到達しないこと。
 */

const publicLookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup: LookupFn = async () => [{ address: '10.0.0.5', family: 4 }];
const NOW = () => new Date('2026-07-16T00:00:00Z');

test('SSRF: feed_url がプライベートIPリテラルなら取得せず error(fetch を呼ばない)', async () => {
  const repos = createMemoryRepositories();
  await seedFeed(repos, { feedUrl: 'http://169.254.169.254/latest/meta-data/' });
  const fetchFn = createFakeFetch(() => xmlResponse(RSS_FIXTURE));

  const result = await collectDueFeeds({ repos, fetchFn, now: NOW, lookupFn: publicLookup });

  assert.equal(result.feeds[0]?.status, 'error');
  assert.equal(fetchFn.calls.length, 0, '内部アドレスへは fetch してはならない');
  assert.equal((await repos.articles.listRecent()).length, 0);
});

test('SSRF: feed_url の名前解決がプライベートIPなら取得せず error', async () => {
  const repos = createMemoryRepositories();
  await seedFeed(repos, { feedUrl: 'https://internal.example/rss.xml' });
  const fetchFn = createFakeFetch(() => xmlResponse(RSS_FIXTURE));

  const result = await collectDueFeeds({ repos, fetchFn, now: NOW, lookupFn: privateLookup });

  assert.equal(result.feeds[0]?.status, 'error');
  assert.equal(fetchFn.calls.length, 0, '解決先がプライベートなら fetch してはならない');
});

test('SSRF: 公開feedがプライベートIPへ302リダイレクトしても内部へ接続しない', async () => {
  const repos = createMemoryRepositories();
  await seedFeed(repos, { feedUrl: 'https://feed.example/rss.xml' });
  const fetchFn = createFakeFetch((url) => {
    if (url === 'https://feed.example/rss.xml') {
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:5432/' } });
    }
    // ここに到達したら SSRF(内部接続)成立 = テスト失敗させる
    return xmlResponse(RSS_FIXTURE);
  });

  const result = await collectDueFeeds({ repos, fetchFn, now: NOW, lookupFn: publicLookup });

  assert.equal(result.feeds[0]?.status, 'error');
  assert.deepEqual(
    fetchFn.calls.map((c) => c.url),
    ['https://feed.example/rss.xml'],
    'リダイレクト先(内部)へは接続してはならない',
  );
});

test('SSRF: 公開ホストへの302リダイレクトは再検証のうえ追従して収集できる', async () => {
  const repos = createMemoryRepositories();
  await seedFeed(repos, { feedUrl: 'https://feed.example/rss.xml' });
  const fetchFn = createFakeFetch((url) => {
    if (url === 'https://feed.example/rss.xml') {
      return new Response(null, { status: 301, headers: { location: 'https://cdn.example/rss.xml' } });
    }
    return xmlResponse(RSS_FIXTURE);
  });

  const result = await collectDueFeeds({ repos, fetchFn, now: NOW, lookupFn: publicLookup });

  assert.equal(result.feeds[0]?.status, 'ok');
  assert.ok(result.totalInserted > 0, 'リダイレクト追従先の記事が収集される');
  assert.equal(fetchFn.calls.length, 2, '元URLとリダイレクト先の2回');
});

test('SSRF: trustEgressProxy=true ではDNS解決せず(lookup未使用)IPリテラルのみ拒否', async () => {
  const repos = createMemoryRepositories();
  await seedFeed(repos, { feedUrl: 'https://feed.example/rss.xml' });
  const fetchFn = createFakeFetch(() => xmlResponse(RSS_FIXTURE));
  let lookupCalled = false;
  const spyingLookup: LookupFn = async (h, o) => {
    lookupCalled = true;
    return publicLookup(h, o);
  };

  const result = await collectDueFeeds({
    repos,
    fetchFn,
    now: NOW,
    trustEgressProxy: true,
    lookupFn: spyingLookup,
  });

  assert.equal(result.feeds[0]?.status, 'ok');
  assert.equal(lookupCalled, false, 'プロキシ信頼モードでは名前解決を行わない');

  // 同モードでも IP リテラルのプライベート宛ては拒否
  const repos2 = createMemoryRepositories();
  await seedFeed(repos2, { feedUrl: 'http://10.1.2.3/rss.xml' });
  const fetchFn2 = createFakeFetch(() => xmlResponse(RSS_FIXTURE));
  const result2 = await collectDueFeeds({ repos: repos2, fetchFn: fetchFn2, now: NOW, trustEgressProxy: true });
  assert.equal(result2.feeds[0]?.status, 'error');
  assert.equal(fetchFn2.calls.length, 0);
});
