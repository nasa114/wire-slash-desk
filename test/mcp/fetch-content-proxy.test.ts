import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepositories } from '../../src/repo/memory/index.ts';
import {
  fetchArticleContent,
  resetHostRateLimiter,
  type FetchContentDeps,
  type FetchFn,
} from '../../src/mcp/fetch-content.ts';
import type { LookupFn } from '../../src/server/ssrf.ts';

/** この開発環境同様、外部 DNS 解決が常に失敗する lookup。 */
const dnsUnavailable: LookupFn = async () => {
  const err = new Error('getaddrinfo EAI_AGAIN example.com') as NodeJS.ErrnoException;
  err.code = 'EAI_AGAIN';
  throw err;
};

function htmlResponse(body: string) {
  return {
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'text/html' : null) },
    body: null,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  };
}

async function seedArticle(url: string) {
  const repos = createMemoryRepositories();
  const feed = await repos.feeds.create({
    name: 'allowed',
    feedUrl: 'https://allowed.example.com/rss',
    fulltextAllowed: true,
  });
  await repos.articles.upsertMany([{ feedId: feed.id, guid: 'g1', title: 't', url }]);
  const [article] = await repos.articles.listRecent({ feedId: feed.id });
  assert.ok(article);
  return { repos, article };
}

function makeDeps(
  repos: Awaited<ReturnType<typeof seedArticle>>['repos'],
  fetchFn: FetchFn,
  overrides: Partial<FetchContentDeps> = {},
): FetchContentDeps {
  return {
    repos,
    cacheFulltext: false,
    fetchFn,
    lookupFn: dnsUnavailable,
    now: () => new Date('2026-07-16T00:00:00Z'),
    userAgent: 'test-agent',
    ...overrides,
  };
}

beforeEach(() => resetHostRateLimiter());

test('trustEgressProxy=true: DNS が使えなくても取得できる(egress 制御はプロキシに委譲)', async () => {
  const { repos, article } = await seedArticle('https://example.com/post');
  let fetched = false;
  const fetchFn: FetchFn = async () => {
    fetched = true;
    return htmlResponse('<html><body>hello proxy</body></html>');
  };
  const result = await fetchArticleContent(
    makeDeps(repos, fetchFn, { trustEgressProxy: true }),
    article.id,
  );
  assert.equal(fetched, true);
  assert.match(result.content, /hello proxy/);
});

test('trustEgressProxy=true でもプライベート IP リテラルは拒否(fetch 未到達)', async () => {
  const { repos, article } = await seedArticle('http://127.0.0.1/internal');
  let fetched = false;
  const fetchFn: FetchFn = async () => {
    fetched = true;
    return htmlResponse('should not happen');
  };
  await assert.rejects(
    fetchArticleContent(makeDeps(repos, fetchFn, { trustEgressProxy: true }), article.id),
    /non-public|private/i,
  );
  assert.equal(fetched, false);
});

test('trustEgressProxy=true でも http/https 以外は拒否', async () => {
  const { repos, article } = await seedArticle('ftp://example.com/file');
  await assert.rejects(
    fetchArticleContent(
      makeDeps(repos, async () => htmlResponse('x'), { trustEgressProxy: true }),
      article.id,
    ),
    /scheme/i,
  );
});

test('trustEgressProxy=true でも別ホストへのリダイレクトは拒否', async () => {
  const { repos, article } = await seedArticle('https://example.com/post');
  const fetchFn: FetchFn = async () => ({
    status: 302,
    headers: { get: (n: string) => (n.toLowerCase() === 'location' ? 'https://evil.example.net/' : null) },
    body: null,
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  await assert.rejects(
    fetchArticleContent(makeDeps(repos, fetchFn, { trustEgressProxy: true }), article.id),
    /different host/i,
  );
});

test('既定(trustEgressProxy 未指定)は従来どおり DNS 解決を要求する', async () => {
  const { repos, article } = await seedArticle('https://example.com/post');
  let fetched = false;
  const fetchFn: FetchFn = async () => {
    fetched = true;
    return htmlResponse('x');
  };
  await assert.rejects(fetchArticleContent(makeDeps(repos, fetchFn), article.id));
  assert.equal(fetched, false);
});
