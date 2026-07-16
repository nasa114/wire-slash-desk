import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Repositories } from '../domain/repositories.ts';
import type { Article, Feed } from '../domain/types.ts';
import { defaultLookup, type LookupFn } from '../server/ssrf.ts';
import {
  fetchArticleContent,
  FetchContentError,
  type FetchFn,
} from './fetch-content.ts';

export interface McpServerDeps {
  repos: Repositories;
  cacheFulltext: boolean;
  fetchFn?: FetchFn;
  lookupFn?: LookupFn;
  now?: () => Date;
  userAgent?: string;
  /** egress プロキシ信頼モード(src/config.ts trustEgressProxy 参照)。既定 false。 */
  trustEgressProxy?: boolean;
}

function toIso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

function feedView(feed: Feed): Record<string, unknown> {
  return {
    id: feed.id,
    name: feed.name,
    feed_url: feed.feedUrl,
    site_url: feed.siteUrl,
    fulltext_allowed: feed.fulltextAllowed,
    translate: feed.translate,
    enabled: feed.enabled,
    last_fetched_at: toIso(feed.lastFetchedAt),
  };
}

function articleView(article: Article): Record<string, unknown> {
  return {
    id: article.id,
    feed_id: article.feedId,
    title: article.title,
    url: article.url,
    published_at: toIso(article.publishedAt),
  };
}

function textResult(payload: unknown): {
  content: { type: 'text'; text: string }[];
} {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function errorResult(message: string): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** MCP 読み取りツール群を登録した McpServer を生成(設計書 §7)。 */
export function createMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer(
    { name: 'personal-rss-reader', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  const fetchDeps = {
    repos: deps.repos,
    cacheFulltext: deps.cacheFulltext,
    fetchFn: deps.fetchFn ?? (globalThis.fetch as unknown as FetchFn),
    lookupFn: deps.lookupFn ?? defaultLookup,
    now: deps.now ?? (() => new Date()),
    userAgent: deps.userAgent ?? 'personal-rss-reader/0.1',
    trustEgressProxy: deps.trustEgressProxy ?? false,
  };

  server.registerTool(
    'list_feeds',
    {
      description: 'List configured feeds with their flags.',
      inputSchema: {},
    },
    async () => {
      const feeds = await deps.repos.feeds.list();
      return textResult(feeds.map(feedView));
    },
  );

  server.registerTool(
    'list_recent_articles',
    {
      description: 'List recent articles (title/url/published_at). Default limit 50, max 200.',
      inputSchema: {
        since: z.string().optional(),
        feed_id: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ since, feed_id, limit }) => {
      let sinceDate: Date | undefined;
      if (since !== undefined) {
        const parsed = new Date(since);
        if (Number.isNaN(parsed.getTime())) {
          return errorResult('invalid "since" value; expected an ISO 8601 datetime');
        }
        sinceDate = parsed;
      }
      const articles = await deps.repos.articles.listRecent({
        since: sinceDate,
        feedId: feed_id,
        limit,
      });
      return textResult(articles.map(articleView));
    },
  );

  server.registerTool(
    'search_articles',
    {
      description: 'Search articles by title (ILIKE). Default limit 50, max 200.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ query, limit }) => {
      const articles = await deps.repos.articles.searchByTitle(query, limit);
      return textResult(articles.map(articleView));
    },
  );

  server.registerTool(
    'get_daily_titles',
    {
      description: 'List article titles published on the given UTC date (YYYY-MM-DD).',
      inputSchema: {
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      },
    },
    async ({ date }) => {
      const articles = await deps.repos.articles.listByDate(date);
      return textResult(articles.map(articleView));
    },
  );

  server.registerTool(
    'fetch_article_content',
    {
      description:
        'Fetch the full text of a stored article on demand. Requires the source to have fulltext_allowed=true.',
      inputSchema: {
        article_id: z.string().min(1),
      },
    },
    async ({ article_id }) => {
      try {
        const result = await fetchArticleContent(fetchDeps, article_id);
        return textResult({
          article_id: result.articleId,
          url: result.url,
          content: result.content,
        });
      } catch (err) {
        if (err instanceof FetchContentError) {
          return errorResult(err.message);
        }
        return errorResult('failed to fetch article content');
      }
    },
  );

  return server;
}
