import type { Repositories } from '../../domain/repositories.ts';
import { createMemoryStore } from './store.ts';
import { MemoryFeedRepository } from './feed-repository.ts';
import { MemoryArticleRepository } from './article-repository.ts';

/** テスト・ローカル動作確認用のインメモリ実装(T1-2 の fake)。 */
export function createMemoryRepositories(): Repositories {
  const store = createMemoryStore();
  return {
    feeds: new MemoryFeedRepository(store),
    articles: new MemoryArticleRepository(store),
    close: async () => {},
  };
}
