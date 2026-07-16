import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp, type AppDeps } from '../../src/server/app.ts';
import { createMemoryRepositories } from '../../src/repo/memory/index.ts';
import type { Repositories } from '../../src/domain/repositories.ts';
import type { LookupFn } from '../../src/server/ssrf.ts';
import type { FetchFn, FetchResponse } from '../../src/mcp/fetch-content.ts';
import { resetHostRateLimiter } from '../../src/mcp/fetch-content.ts';

const BEARER = 'bearer-secret';

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
    mcpBearerToken: BEARER,
    collectorToken: 'collector-secret',
    cacheFulltext: false,
    ...overrides,
  };
}

async function connectClient(url: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

function parseText(result: unknown): unknown {
  const r = result as ToolResult;
  assert.ok(Array.isArray(r.content) && r.content[0], 'expected content');
  return JSON.parse(r.content[0].text);
}

function fakeResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): FetchResponse {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    headers: { get: (n: string) => lower[n.toLowerCase()] ?? null },
    body: null,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

const publicLookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];

async function seed(repos: Repositories): Promise<{
  feedAllowed: string;
  feedDenied: string;
  articleAllowed: string;
}> {
  const allowed = await repos.feeds.create({
    name: 'Allowed',
    feedUrl: 'https://allowed.example.com/feed',
    siteUrl: 'https://allowed.example.com',
    fulltextAllowed: true,
  });
  const denied = await repos.feeds.create({
    name: 'Denied',
    feedUrl: 'https://denied.example.com/feed',
    fulltextAllowed: false,
  });
  await repos.articles.upsertMany([
    {
      feedId: allowed.id,
      guid: 'a1',
      title: 'Alpha security release',
      url: 'https://allowed.example.com/alpha',
      publishedAt: new Date('2026-07-10T09:00:00.000Z'),
    },
    {
      feedId: allowed.id,
      guid: 'a2',
      title: 'Beta feature announcement',
      url: 'https://allowed.example.com/beta',
      publishedAt: new Date('2026-07-11T12:00:00.000Z'),
    },
    {
      feedId: denied.id,
      guid: 'd1',
      title: 'Gamma post',
      url: 'https://denied.example.com/gamma',
      publishedAt: new Date('2026-07-10T20:00:00.000Z'),
    },
  ]);
  const recent = await repos.articles.listRecent({ feedId: allowed.id });
  const alpha = recent.find((a) => a.guid === 'a1');
  assert.ok(alpha);
  return { feedAllowed: allowed.id, feedDenied: denied.id, articleAllowed: alpha.id };
}

test('/mcp without Authorization -> 401 + WWW-Authenticate', async () => {
  const { url, close } = await listen(createApp(baseDeps()));
  try {
    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    await res.text();
  } finally {
    await close();
  }
});

test('/mcp with wrong Bearer -> 401', async () => {
  const { url, close } = await listen(createApp(baseDeps()));
  try {
    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer nope',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(res.status, 401);
    await res.text();
  } finally {
    await close();
  }
});

test('/mcp GET and DELETE -> 405', async () => {
  const { url, close } = await listen(createApp(baseDeps()));
  try {
    assert.equal((await fetch(`${url}/mcp`)).status, 405);
    assert.equal((await fetch(`${url}/mcp`, { method: 'DELETE' })).status, 405);
  } finally {
    await close();
  }
});

test('MCP initialize succeeds with valid Bearer', async () => {
  const { url, close } = await listen(createApp(baseDeps()));
  const client = await connectClient(url, BEARER);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'fetch_article_content',
      'get_daily_titles',
      'list_feeds',
      'list_recent_articles',
      'search_articles',
    ]);
  } finally {
    await client.close();
    await close();
  }
});

test('list_feeds returns feed views with flags', async () => {
  const repos = createMemoryRepositories();
  const { feedAllowed } = await seed(repos);
  const { url, close } = await listen(createApp(baseDeps({ repos })));
  const client = await connectClient(url, BEARER);
  try {
    const res = await client.callTool({ name: 'list_feeds', arguments: {} });
    const feeds = parseText(res) as Array<Record<string, unknown>>;
    assert.equal(feeds.length, 2);
    const allowed = feeds.find((f) => f.id === feedAllowed);
    assert.ok(allowed);
    assert.equal(allowed.fulltext_allowed, true);
    assert.equal(allowed.feed_url, 'https://allowed.example.com/feed');
  } finally {
    await client.close();
    await close();
  }
});

test('list_recent_articles honours since, feed_id and limit', async () => {
  const repos = createMemoryRepositories();
  const { feedAllowed } = await seed(repos);
  const { url, close } = await listen(createApp(baseDeps({ repos })));
  const client = await connectClient(url, BEARER);
  try {
    const all = parseText(await client.callTool({ name: 'list_recent_articles', arguments: {} })) as unknown[];
    assert.equal(all.length, 3);

    const byFeed = parseText(
      await client.callTool({ name: 'list_recent_articles', arguments: { feed_id: feedAllowed } }),
    ) as Array<Record<string, unknown>>;
    assert.equal(byFeed.length, 2);
    assert.ok(byFeed.every((a) => a.feed_id === feedAllowed));

    const since = parseText(
      await client.callTool({
        name: 'list_recent_articles',
        arguments: { since: '2026-07-11T00:00:00.000Z' },
      }),
    ) as unknown[];
    assert.equal(since.length, 1);

    const limited = parseText(
      await client.callTool({ name: 'list_recent_articles', arguments: { limit: 1 } }),
    ) as unknown[];
    assert.equal(limited.length, 1);
  } finally {
    await client.close();
    await close();
  }
});

test('search_articles matches title substring', async () => {
  const repos = createMemoryRepositories();
  await seed(repos);
  const { url, close } = await listen(createApp(baseDeps({ repos })));
  const client = await connectClient(url, BEARER);
  try {
    const res = parseText(
      await client.callTool({ name: 'search_articles', arguments: { query: 'security' } }),
    ) as Array<Record<string, unknown>>;
    assert.equal(res.length, 1);
    assert.equal(res[0]?.title, 'Alpha security release');
  } finally {
    await client.close();
    await close();
  }
});

test('get_daily_titles returns titles for the UTC date', async () => {
  const repos = createMemoryRepositories();
  await seed(repos);
  const { url, close } = await listen(createApp(baseDeps({ repos })));
  const client = await connectClient(url, BEARER);
  try {
    const res = parseText(
      await client.callTool({ name: 'get_daily_titles', arguments: { date: '2026-07-10' } }),
    ) as Array<Record<string, unknown>>;
    const titles = res.map((a) => a.title).sort();
    assert.deepEqual(titles, ['Alpha security release', 'Gamma post']);
  } finally {
    await client.close();
    await close();
  }
});

test('fetch_article_content: fulltext_allowed=false is rejected and fetch not called', async () => {
  const repos = createMemoryRepositories();
  const { feedDenied } = await seed(repos);
  const denied = (await repos.articles.listRecent({ feedId: feedDenied }))[0];
  assert.ok(denied);
  let fetchCalled = false;
  const fetchFn: FetchFn = async () => {
    fetchCalled = true;
    return fakeResponse(200, 'x');
  };
  const { url, close } = await listen(
    createApp(baseDeps({ repos, fetchFn, lookupFn: publicLookup })),
  );
  const client = await connectClient(url, BEARER);
  try {
    const res = (await client.callTool({
      name: 'fetch_article_content',
      arguments: { article_id: denied.id },
    })) as ToolResult;
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /not allowed/i);
    assert.equal(fetchCalled, false);
  } finally {
    await client.close();
    await close();
  }
});

test('fetch_article_content: allowed fetch returns plain text and does NOT persist by default', async () => {
  resetHostRateLimiter();
  const repos = createMemoryRepositories();
  const { articleAllowed } = await seed(repos);
  const fetchFn: FetchFn = async () =>
    fakeResponse(
      200,
      '<html><head><style>.x{}</style></head><body><script>bad()</script><p>Hello &amp; world</p></body></html>',
      { 'content-type': 'text/html; charset=utf-8' },
    );
  const { url, close } = await listen(
    createApp(baseDeps({ repos, fetchFn, lookupFn: publicLookup, cacheFulltext: false })),
  );
  const client = await connectClient(url, BEARER);
  try {
    const res = parseText(
      await client.callTool({
        name: 'fetch_article_content',
        arguments: { article_id: articleAllowed },
      }),
    ) as Record<string, unknown>;
    assert.match(res.content as string, /Hello & world/);
    assert.equal(/bad\(\)/.test(res.content as string), false, 'script removed');
    // 既定では永続化しない。
    const stored = await repos.articles.getById(articleAllowed);
    assert.equal(stored?.content, null);
  } finally {
    await client.close();
    await close();
  }
});

test('fetch_article_content: cacheFulltext=true persists content', async () => {
  resetHostRateLimiter();
  const repos = createMemoryRepositories();
  const { articleAllowed } = await seed(repos);
  const fetchFn: FetchFn = async () =>
    fakeResponse(200, '<p>Cached body</p>', { 'content-type': 'text/html' });
  const { url, close } = await listen(
    createApp(baseDeps({ repos, fetchFn, lookupFn: publicLookup, cacheFulltext: true })),
  );
  const client = await connectClient(url, BEARER);
  try {
    await client.callTool({
      name: 'fetch_article_content',
      arguments: { article_id: articleAllowed },
    });
    const stored = await repos.articles.getById(articleAllowed);
    assert.match(stored?.content ?? '', /Cached body/);
  } finally {
    await client.close();
    await close();
  }
});

test('fetch_article_content: host resolving to private IP is rejected', async () => {
  resetHostRateLimiter();
  const repos = createMemoryRepositories();
  const { articleAllowed } = await seed(repos);
  const privLookup: LookupFn = async () => [{ address: '10.0.0.9', family: 4 }];
  let fetchCalled = false;
  const fetchFn: FetchFn = async () => {
    fetchCalled = true;
    return fakeResponse(200, 'x');
  };
  const { url, close } = await listen(
    createApp(baseDeps({ repos, fetchFn, lookupFn: privLookup })),
  );
  const client = await connectClient(url, BEARER);
  try {
    const res = (await client.callTool({
      name: 'fetch_article_content',
      arguments: { article_id: articleAllowed },
    })) as ToolResult;
    assert.equal(res.isError, true);
    assert.equal(fetchCalled, false);
  } finally {
    await client.close();
    await close();
  }
});

test('fetch_article_content: 127.0.0.1 literal URL is rejected', async () => {
  resetHostRateLimiter();
  const repos = createMemoryRepositories();
  const feed = await repos.feeds.create({
    name: 'Loopback',
    feedUrl: 'https://loop.example.com/feed',
    fulltextAllowed: true,
  });
  await repos.articles.upsertMany([
    { feedId: feed.id, guid: 'lit', title: 'Loopback', url: 'http://127.0.0.1/secret' },
  ]);
  const article = (await repos.articles.listRecent({ feedId: feed.id }))[0];
  assert.ok(article);
  let fetchCalled = false;
  const fetchFn: FetchFn = async () => {
    fetchCalled = true;
    return fakeResponse(200, 'x');
  };
  const { url, close } = await listen(
    createApp(baseDeps({ repos, fetchFn, lookupFn: publicLookup })),
  );
  const client = await connectClient(url, BEARER);
  try {
    const res = (await client.callTool({
      name: 'fetch_article_content',
      arguments: { article_id: article.id },
    })) as ToolResult;
    assert.equal(res.isError, true);
    assert.equal(fetchCalled, false);
  } finally {
    await client.close();
    await close();
  }
});

test('fetch_article_content: redirect to a different host is rejected', async () => {
  resetHostRateLimiter();
  const repos = createMemoryRepositories();
  const { articleAllowed } = await seed(repos);
  const fetchFn: FetchFn = async () =>
    fakeResponse(302, '', { location: 'https://evil.example.net/steal' });
  const { url, close } = await listen(
    createApp(baseDeps({ repos, fetchFn, lookupFn: publicLookup })),
  );
  const client = await connectClient(url, BEARER);
  try {
    const res = (await client.callTool({
      name: 'fetch_article_content',
      arguments: { article_id: articleAllowed },
    })) as ToolResult;
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /host/i);
  } finally {
    await client.close();
    await close();
  }
});

test('fetch_article_content: same-host redirects within limit succeed', async () => {
  resetHostRateLimiter();
  const repos = createMemoryRepositories();
  const { articleAllowed } = await seed(repos);
  let hop = 0;
  const fetchFn: FetchFn = async (target) => {
    hop += 1;
    if (hop <= 3) {
      // 同一ホスト内の相対リダイレクト。
      return fakeResponse(302, '', { location: `https://allowed.example.com/hop${hop}` });
    }
    assert.match(target, /allowed\.example\.com/);
    return fakeResponse(200, '<p>Final body</p>', { 'content-type': 'text/html' });
  };
  const { url, close } = await listen(
    createApp(baseDeps({ repos, fetchFn, lookupFn: publicLookup })),
  );
  const client = await connectClient(url, BEARER);
  try {
    const res = parseText(
      await client.callTool({
        name: 'fetch_article_content',
        arguments: { article_id: articleAllowed },
      }),
    ) as Record<string, unknown>;
    assert.match(res.content as string, /Final body/);
    assert.equal(hop, 4);
  } finally {
    await client.close();
    await close();
  }
});
