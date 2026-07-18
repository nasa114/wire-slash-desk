import type { Repositories } from '../../domain/repositories.ts';
import { createMemoryStore } from './store.ts';
import { MemoryFeedRepository } from './feed-repository.ts';
import { MemoryArticleRepository } from './article-repository.ts';
import { MemoryUserRepository } from './user-repository.ts';
import { MemorySessionRepository } from './session-repository.ts';
import {
  MemoryOAuthClientRepository,
  MemoryOAuthCodeRepository,
  MemoryOAuthTokenRepository,
} from './oauth-repositories.ts';

/** テスト・ローカル動作確認用のインメモリ実装(T1-2 の fake)。 */
export function createMemoryRepositories(): Repositories {
  const store = createMemoryStore();
  return {
    feeds: new MemoryFeedRepository(store),
    articles: new MemoryArticleRepository(store),
    users: new MemoryUserRepository(store),
    sessions: new MemorySessionRepository(store),
    oauthClients: new MemoryOAuthClientRepository(store),
    oauthCodes: new MemoryOAuthCodeRepository(store),
    oauthTokens: new MemoryOAuthTokenRepository(store),
    close: async () => {},
  };
}
