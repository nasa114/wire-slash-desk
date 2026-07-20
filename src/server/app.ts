import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { Repositories } from '../domain/repositories.ts';
import { createMcpServer } from '../mcp/server.ts';
import type { FetchFn } from '../mcp/fetch-content.ts';
import type { LookupFn } from './ssrf.ts';
import { verifyBearer, verifyCollectorToken } from './auth.ts';
import { OAUTH_SCOPES, RssOAuthProvider } from './oauth-provider.ts';
import { createWebApp } from './web.ts';
import { UNKNOWN_BUILD_INFO, type BuildInfo } from './build-info.ts';

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
  /** egress プロキシ信頼モード(src/config.ts trustEgressProxy 参照)。既定 false。 */
  trustEgressProxy?: boolean;
  /** セッション Cookie に Secure 属性を付ける(TLS 配下で true)。既定 false。 */
  cookieSecure?: boolean;
  /** 初回セットアップを保護する任意トークン(PT-001)。未設定なら従来どおり無保護。 */
  setupToken?: string;
  /**
   * MCP OAuth 2.1(T4-2)の issuer URL(例: https://reader.example)。
   * 指定時のみ /authorize /token /register /revoke と well-known メタデータが
   * 有効になる。未指定なら従来どおり静的 Bearer のみ。
   */
  oauthIssuerUrl?: string;
  /**
   * バージョン・ビルド情報(src/server/build-info.ts)。認証済み UI のフッターと
   * GET /internal/version(X-Collector-Token 必須)に表示する。未指定なら unknown。
   */
  buildInfo?: BuildInfo;
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
  const buildInfo = deps.buildInfo ?? UNKNOWN_BUILD_INFO;
  // MCP OAuth 2.1(設計書 §7 Phase B)。プロトコル実装は SDK の公式ハンドラ
  // (express ベース)に委ね、発行・保存は RssOAuthProvider がリポジトリへ橋渡し。
  let oauthProvider: RssOAuthProvider | undefined;
  let oauthListener: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  let resourceMetadataUrl: string | undefined;
  if (deps.oauthIssuerUrl !== undefined) {
    const issuerUrl = new URL(deps.oauthIssuerUrl);
    oauthProvider = new RssOAuthProvider({
      repos: deps.repos,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
    resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL('/mcp', issuerUrl));
    const oauthApp = express();
    oauthApp.use(
      mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl,
        resourceServerUrl: new URL('/mcp', issuerUrl),
        scopesSupported: OAUTH_SCOPES,
        resourceName: 'Personal RSS Reader',
      }),
    );
    oauthListener = oauthApp;
  }
  /** SDK ルーターが root にマウントする OAuth エンドポイント群。 */
  const OAUTH_ENDPOINTS = new Set(['/authorize', '/token', '/register', '/revoke']);
  const isOAuthPath = (p: string): boolean =>
    OAUTH_ENDPOINTS.has(p) || p.startsWith('/.well-known/oauth-');

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

  /**
   * /mcp の認証: 静的 Bearer(Phase A、Codex 等 OAuth 非対応クライアント用に共存)
   * または OAuth アクセストークン(Phase B)のどちらかを受け入れる。
   */
  const authenticateMcp = async (authValue: string | undefined): Promise<boolean> => {
    if (verifyBearer(authValue, deps.mcpBearerToken)) return true;
    if (oauthProvider === undefined || authValue === undefined) return false;
    if (!authValue.startsWith('Bearer ')) return false;
    try {
      await oauthProvider.verifyAccessToken(authValue.slice('Bearer '.length));
      return true;
    } catch {
      return false;
    }
  };

  const handleMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const auth = req.headers['authorization'];
    const authValue = Array.isArray(auth) ? auth[0] : auth;
    if (!(await authenticateMcp(authValue))) {
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        // RFC 9728 / MCP authorization 仕様: クライアントはこのメタデータ URL から
        // 認可サーバーを発見してフローを開始する。
        'www-authenticate':
          resourceMetadataUrl !== undefined
            ? `Bearer resource_metadata="${resourceMetadataUrl}"`
            : 'Bearer',
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
      trustEgressProxy: deps.trustEgressProxy,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  };

  // ブラウザ向け Web UI(Hono)。/healthz /internal/collect /mcp 以外をすべて委譲する。
  const webApp = createWebApp({
    repos: deps.repos,
    cookieSecure: deps.cookieSecure ?? false,
    buildInfo,
    ...(deps.setupToken !== undefined ? { setupToken: deps.setupToken } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(oauthProvider !== undefined ? { oauthProvider } : {}),
  });
  const webListener = getRequestListener(webApp.fetch);

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
      if (path === '/internal/version') {
        // デプロイ確認用。ブラウザから無認証で開けないよう collector トークンを課す。
        if (method !== 'GET') {
          sendJson(res, 405, { status: 'method_not_allowed' });
          return;
        }
        const token = req.headers['x-collector-token'];
        const headerValue = Array.isArray(token) ? token[0] : token;
        if (!verifyCollectorToken(headerValue, deps.collectorToken)) {
          sendJson(res, 401, { status: 'unauthorized' });
          return;
        }
        sendJson(res, 200, { status: 'ok', ...buildInfo });
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
      if (oauthListener !== undefined && path !== undefined && isOAuthPath(path)) {
        // OAuth エンドポイントは SDK の express ルーターに委譲する。
        oauthListener(req, res);
        return;
      }
      // それ以外(/, /articles, /feeds, /login, /setup, /assets, 旧 /ui 互換)は Web UI。
      await webListener(req, res);
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
