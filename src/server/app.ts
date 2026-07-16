import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Repositories } from '../domain/repositories.ts';
import { createMcpServer } from '../mcp/server.ts';
import type { FetchFn } from '../mcp/fetch-content.ts';
import type { LookupFn } from './ssrf.ts';
import { verifyBearer, verifyCollectorToken } from './auth.ts';

export interface AppDeps {
  repos: Repositories;
  runCollect: () => Promise<unknown>;
  mcpBearerToken: string;
  collectorToken: string;
  cacheFulltext: boolean;
  fetchFn?: FetchFn;
  lookupFn?: LookupFn;
  now?: () => Date;
  userAgent?: string;
}

const MAX_COLLECT_BODY_BYTES = 64 * 1024;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function drainBody(req: IncomingMessage, maxBytes: number): Promise<void> {
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) {
      req.destroy();
      return;
    }
  }
}

/** node:http の Server を生成(未 listen)。設計書 §7, §8。 */
export function createApp(deps: AppDeps): Server {
  // 二重発火対策(single-flight): 実行中の collect Promise を共有する。
  let inflightCollect: Promise<unknown> | null = null;

  const runCollectShared = (): Promise<unknown> => {
    if (inflightCollect === null) {
      inflightCollect = Promise.resolve()
        .then(() => deps.runCollect())
        .finally(() => {
          inflightCollect = null;
        });
    }
    return inflightCollect;
  };

  const handleCollect = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const token = req.headers['x-collector-token'];
    const headerValue = Array.isArray(token) ? token[0] : token;
    if (!verifyCollectorToken(headerValue, deps.collectorToken)) {
      // 本文に理由を書きすぎない。
      sendJson(res, 401, { status: 'unauthorized' });
      // 認証失敗でもボディは読み捨てて接続を綺麗に閉じる。
      await drainBody(req, MAX_COLLECT_BODY_BYTES).catch(() => {});
      return;
    }
    await drainBody(req, MAX_COLLECT_BODY_BYTES).catch(() => {});
    // 並行呼び出しは同じ Promise を待って同じ結果を返す。
    const promise = runCollectShared();
    try {
      const result = await promise;
      sendJson(res, 200, { status: 'ok', result });
    } catch {
      sendJson(res, 500, { status: 'error' });
    }
  };

  const handleMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const auth = req.headers['authorization'];
    const authValue = Array.isArray(auth) ? auth[0] : auth;
    if (!verifyBearer(authValue, deps.mcpBearerToken)) {
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'www-authenticate': 'Bearer',
      });
      res.end(JSON.stringify({ status: 'unauthorized' }));
      return;
    }

    // ステートレス: リクエスト毎に新しい McpServer + transport。
    const mcpServer = createMcpServer({
      repos: deps.repos,
      cacheFulltext: deps.cacheFulltext,
      fetchFn: deps.fetchFn,
      lookupFn: deps.lookupFn,
      now: deps.now,
      userAgent: deps.userAgent,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  };

  const server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const path = url.split('?', 1)[0];

    const handle = async (): Promise<void> => {
      if (method === 'GET' && path === '/healthz') {
        // 認証不要・DB に触らない。
        sendJson(res, 200, { status: 'ok' });
        return;
      }
      if (path === '/internal/collect') {
        if (method !== 'POST') {
          sendJson(res, 405, { status: 'method_not_allowed' });
          return;
        }
        await handleCollect(req, res);
        return;
      }
      if (path === '/mcp') {
        if (method === 'POST') {
          await handleMcp(req, res);
          return;
        }
        // ステートレスのため GET/DELETE は非対応。
        sendJson(res, 405, { status: 'method_not_allowed' });
        return;
      }
      sendJson(res, 404, { status: 'not_found' });
    };

    handle().catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { status: 'error' });
      } else {
        res.end();
      }
    });
  });

  return server;
}
