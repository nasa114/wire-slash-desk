import { test, after } from 'node:test';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { Repositories } from '../../src/domain/repositories.ts';
import { createPgRepositories } from '../../src/repo/pg/index.ts';
import { runFeedRepositoryContract } from '../contract/feed-repository.contract.ts';
import { runArticleRepositoryContract } from '../contract/article-repository.contract.ts';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  test('PgRepositories: 契約テスト(DATABASE_URL 未設定のためスキップ)', (t) => {
    t.skip('DATABASE_URL is not set');
  });
} else {
  // test/integration/pg-repositories.test.ts から見たプロジェクトルート。
  const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

  // マイグレーションを適用してからテストする(T1-1 のマイグレーションを結合テストの前提とする)。
  execSync('npm run migrate', { cwd: projectRoot, stdio: 'inherit', env: process.env });

  const truncatePool = new Pool({ connectionString: databaseUrl });

  const makeRepos = async (): Promise<Repositories> => {
    // 各テストを隔離するため、Repositories を組み立てる前に毎回テーブルを空にする。
    await truncatePool.query('truncate table articles, feeds restart identity cascade');
    return createPgRepositories(databaseUrl);
  };

  after(async () => {
    await truncatePool.end();
  });

  runFeedRepositoryContract('pg', makeRepos);
  runArticleRepositoryContract('pg', makeRepos);
}
