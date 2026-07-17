import { readFileSync } from 'node:fs';
import type { Repositories } from '../../src/domain/repositories.ts';
import type { Feed } from '../../src/domain/types.ts';
import type { LookupFn } from '../../src/server/ssrf.ts';

/**
 * ネットワーク非依存の SSRF ガード用 lookup。全ホストを公開 IP に解決する。
 * collector が既定で実 DNS を引かないよう、既存テストへ注入する。
 */
export const publicLookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];

export const RSS_FIXTURE = readFileSync(
  new URL('../fixtures/rss2-with-content.xml', import.meta.url),
  'utf8',
);
export const ATOM_FIXTURE = readFileSync(
  new URL('../fixtures/atom-with-content.xml', import.meta.url),
  'utf8',
);

export function xmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/rss+xml' },
    ...init,
  });
}

export async function seedFeed(
  repos: Repositories,
  overrides: Partial<{ feedUrl: string; fetchIntervalMinutes: number; enabled: boolean }> = {},
): Promise<Feed> {
  return repos.feeds.create({
    name: 'Test Feed',
    feedUrl: overrides.feedUrl ?? 'https://example.com/rss.xml',
    fetchIntervalMinutes: overrides.fetchIntervalMinutes ?? 15,
    enabled: overrides.enabled ?? true,
  });
}
