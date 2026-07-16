import { test, after } from 'node:test';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client, Pool } from 'pg';
import type { Repositories } from '../../src/domain/repositories.ts';
import { createPgRepositories } from '../../src/repo/pg/index.ts';
import { runFeedRepositoryContract } from '../contract/feed-repository.contract.ts';
import { runArticleRepositoryContract } from '../contract/article-repository.contract.ts';

const databaseUrl = process.env.DATABASE_URL;

/**
 * 統合テストは開発データを壊さないよう専用 DB を使う。
 * TEST_DATABASE_URL があればそれを、無ければ DATABASE_URL の DB 名に `_test` を
 * 付けた URL を導出し、存在しなければ CREATE DATABASE する。
 */
async function resolveTestDatabaseUrl(baseUrl: string): Promise<string> {
  const explicit = process.env.TEST_DATABASE_URL;
  if (explicit) return explicit;

  const url = new URL(baseUrl);
  const baseDb = url.pathname.replace(/^\//, '') || 'postgres';
  const testDb = `${baseDb}_test`;

  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    const exists = await admin.query('select 1 from pg_database where datname = $1', [testDb]);
    if (exists.rowCount === 0) {
      // CREATE DATABASE は識別子にプレースホルダを使えないため、導出名をクォートして埋め込む。
      await admin.query(`create database "${testDb.replaceAll('"', '""')}"`);
    }
  } finally {
    await admin.end();
  }
  url.pathname = `/${testDb}`;
  return url.toString();
}

if (!databaseUrl) {
  test('PgRepositories: 契約テスト(DATABASE_URL 未設定のためスキップ)', (t) => {
    t.skip('DATABASE_URL is not set');
  });
} else {
  const testDatabaseUrl = await resolveTestDatabaseUrl(databaseUrl);

  // test/integration/pg-repositories.test.ts から見たプロジェクトルート。
  const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

  // テスト専用 DB にマイグレーションを適用してからテストする(T1-1 を結合テストの前提とする)。
  execSync('npm run migrate', {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });

  const truncatePool = new Pool({ connectionString: testDatabaseUrl });

  const makeRepos = async (): Promise<Repositories> => {
    // 各テストを隔離するため、Repositories を組み立てる前に毎回テーブルを空にする。
    await truncatePool.query('truncate table articles, feeds restart identity cascade');
    return createPgRepositories(testDatabaseUrl);
  };

  after(async () => {
    await truncatePool.end();
  });

  runFeedRepositoryContract('pg', makeRepos);
  runArticleRepositoryContract('pg', makeRepos);
}
