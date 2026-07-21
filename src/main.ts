import type { Server } from 'node:http';
import type { Repositories } from './domain/repositories.ts';
import { buildUserAgent, loadConfig } from './config.ts';
import { createApp } from './server/app.ts';
import { loadBuildInfo } from './server/build-info.ts';
import { createRateService } from './rates/service.ts';
import { fetchYahooRate } from './rates/yahoo.ts';

/**
 * 別エージェントが実装中のモジュール群を型を仮定せず動的 import で吸収する。
 * まだ存在しない場合は明確なエラーで起動を止める(fail fast)。
 */
async function loadRepositories(databaseUrl: string): Promise<Repositories> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import('./repo/pg/index.ts')) as Record<string, unknown>;
  } catch {
    throw new Error(
      'PostgreSQL repository module (src/repo/pg/index.ts) is not available yet; cannot start.',
    );
  }
  const factory = mod['createPgRepositories'];
  if (typeof factory !== 'function') {
    throw new Error('createPgRepositories is not exported from src/repo/pg/index.ts.');
  }
  return (factory as (url: string) => Repositories | Promise<Repositories>)(databaseUrl);
}

async function loadRunCollect(
  repos: Repositories,
  userAgent: string,
  trustEgressProxy: boolean,
): Promise<() => Promise<unknown>> {
  try {
    const mod = (await import('./collector/collector.ts')) as Record<string, unknown>;
    const collect = mod['collectDueFeeds'];
    if (typeof collect === 'function') {
      const fn = collect as (options: {
        repos: Repositories;
        userAgent?: string;
        trustEgressProxy?: boolean;
      }) => Promise<unknown>;
      // SSRF ガードは collector 経路にも適用する(設計書 §6)。トラフィックの
      // egress モードは config と一致させる(直接エグレスなら DNS 検査あり)。
      return () => fn({ repos, userAgent, trustEgressProxy });
    }
  } catch {
    // collector 未実装時は起動は許容し、収集は無効化する。
  }
  return async () => {
    throw new Error('collector is not available');
  };
}

async function main(): Promise<void> {
  // loadConfig() は TRUST_EGRESS_PROXY=true 時のプロキシ関連env(HTTPS_PROXY /
  // HTTP_PROXY / NODE_USE_ENV_PROXY=1)の検証も行い、欠落があれば ConfigError を
  // 投げる(src/config.ts の validateEgressProxyTrust 参照)。ここで throw された
  // 例外は下部の main().catch(...) が拾って起動を拒否する(fail fast)。
  const config = loadConfig();

  // トークン未設定なら起動拒否(セキュリティ最優先)。
  const missing: string[] = [];
  if (config.mcpBearerToken === undefined) missing.push('MCP_BEARER_TOKEN');
  if (config.collectorToken === undefined) missing.push('COLLECTOR_TOKEN');
  if (config.databaseUrl === undefined) missing.push('DATABASE_URL');
  if (missing.length > 0) {
    throw new Error(`missing required environment variables: ${missing.join(', ')}`);
  }

  const userAgent = buildUserAgent(config.collectorContact);
  const repos = await loadRepositories(config.databaseUrl as string);
  const runCollect = await loadRunCollect(repos, userAgent, config.trustEgressProxy);

  // 為替レート(設計書 §14)。lazy TTL のため cron は不要で、ダッシュボード表示時に
  // TTL(既定20分)超過分だけ Yahoo Finance から取得して DB キャッシュを更新する。
  const rateService =
    config.exchangeRatePairs.length > 0
      ? createRateService({
          repo: repos.exchangeRates,
          pairs: config.exchangeRatePairs,
          ttlMinutes: config.exchangeRateTtlMinutes,
          fetchRate: (pair, at) =>
            fetchYahooRate(pair, at, { userAgent, trustEgressProxy: config.trustEgressProxy }),
        })
      : undefined;

  const app: Server = createApp({
    repos,
    runCollect,
    mcpBearerToken: config.mcpBearerToken as string,
    collectorToken: config.collectorToken as string,
    cacheFulltext: config.cacheFulltext,
    trustEgressProxy: config.trustEgressProxy,
    cookieSecure: config.cookieSecure,
    ...(config.oauthIssuerUrl !== undefined ? { oauthIssuerUrl: config.oauthIssuerUrl } : {}),
    ...(config.setupToken !== undefined ? { setupToken: config.setupToken } : {}),
    ...(rateService !== undefined ? { getRates: () => rateService.getRates() } : {}),
    userAgent,
    buildInfo: loadBuildInfo(),
  });

  await new Promise<void>((resolve) => {
    app.listen(config.port, () => {
      // eslint-disable-next-line no-console
      console.log(`listening on :${config.port}`);
      resolve();
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`received ${signal}, shutting down`);
    app.close(() => {
      void repos.close().finally(() => process.exit(0));
    });
    // 猶予後に強制終了。
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : 'startup failed');
  process.exit(1);
});
