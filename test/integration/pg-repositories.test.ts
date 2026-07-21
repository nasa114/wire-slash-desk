import { test, after } from 'node:test';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client, Pool } from 'pg';
import type { Repositories } from '../../src/domain/repositories.ts';
import { createPgRepositories } from '../../src/repo/pg/index.ts';
import { runFeedRepositoryContract } from '../contract/feed-repository.contract.ts';
import { runArticleRepositoryContract } from '../contract/article-repository.contract.ts';
import { runUserRepositoryContract } from '../contract/user-repository.contract.ts';
import { runSessionRepositoryContract } from '../contract/session-repository.contract.ts';
import { runOAuthRepositoriesContract } from '../contract/oauth-repositories.contract.ts';
import { runExchangeRateRepositoryContract } from '../contract/exchange-rate-repository.contract.ts';

const databaseUrl = process.env.DATABASE_URL;

/** 23505 系と同様、pg ドライバのエラーコードを取り出す(このファイルはテスト専用ヘルパーのため src/repo/pg/errors.ts とは独立させている)。 */
function pgErrorCode(err: unknown): string | undefined {
  if (err instanceof Error && 'code' in err && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return undefined;
}

/** 42P04: duplicate_database。並行実行時に他プロセスが先に CREATE DATABASE していた場合はこれ。 */
function isDuplicateDatabase(err: unknown): boolean {
  return pgErrorCode(err) === '42P04';
}

/**
 * 統合テストは開発データを壊さないよう専用 DB を使う。
 * TEST_DATABASE_URL があればそれを、無ければ DATABASE_URL の DB 名に `_test` を
 * 付けた URL を導出し、存在しなければ CREATE DATABASE する。
 *
 * 安全弁: いずれの経路でも最終的な DB 名は `_test` で終わることを必須にする。
 * これにより、TEST_DATABASE_URL を誤って開発/本番 DB に向けて設定した場合でも
 * このテストが行う truncate によってデータが失われることを防ぐ。
 */
async function resolveTestDatabaseUrl(baseUrl: string): Promise<string> {
  const explicit = process.env.TEST_DATABASE_URL;
  if (explicit) {
    const explicitDbName = new URL(explicit).pathname.replace(/^\//, '');
    if (!explicitDbName.endsWith('_test')) {
      throw new Error(
        `TEST_DATABASE_URL の database 名は安全のため "_test" で終わる必要があります(誤って開発/本番DBを truncate するのを防ぐ安全弁)。指定値: ${explicitDbName}`,
      );
    }
    return explicit;
  }

  const url = new URL(baseUrl);
  const baseDb = url.pathname.replace(/^\//, '') || 'postgres';
  const testDb = `${baseDb}_test`;

  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    const exists = await admin.query('select 1 from pg_database where datname = $1', [testDb]);
    if (exists.rowCount === 0) {
      try {
        // CREATE DATABASE は識別子にプレースホルダを使えないため、導出名をクォートして埋め込む。
        await admin.query(`create database "${testDb.replaceAll('"', '""')}"`);
      } catch (err) {
        // 存在確認〜作成が非原子的なため、並行実行で他プロセスが先に作成しているとここで
        // duplicate_database (42P04) になり得る。その場合は成功扱いで続行する。
        if (!isDuplicateDatabase(err)) throw err;
      }
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
  const migrateEnv = { ...process.env, DATABASE_URL: testDatabaseUrl };

  // T1-1 の受け入れ条件(up → down → up が冪等であること)をテスト専用 DB に対して
  // 実際に実行して担保してから契約テストに入る。途中で失敗すれば(exit code 非0で)
  // execSync が例外を投げ、このテストファイルのロードごと失敗する。
  execSync('npm run migrate', { cwd: projectRoot, stdio: 'inherit', env: migrateEnv });
  execSync('npm run migrate:down', { cwd: projectRoot, stdio: 'inherit', env: migrateEnv });
  execSync('npm run migrate', { cwd: projectRoot, stdio: 'inherit', env: migrateEnv });

  const truncatePool = new Pool({ connectionString: testDatabaseUrl });

  const makeRepos = async (): Promise<Repositories> => {
    // 各テストを隔離するため、Repositories を組み立てる前に毎回テーブルを空にする。
    await truncatePool.query(
      'truncate table articles, feeds, sessions, users, oauth_tokens, oauth_codes, oauth_clients, exchange_rates restart identity cascade',
    );
    return createPgRepositories(testDatabaseUrl);
  };

  after(async () => {
    await truncatePool.end();
  });

  runFeedRepositoryContract('pg', makeRepos);
  runArticleRepositoryContract('pg', makeRepos);
  runUserRepositoryContract('pg', makeRepos);
  runSessionRepositoryContract('pg', makeRepos);
  runOAuthRepositoriesContract('pg', makeRepos);
  runExchangeRateRepositoryContract('pg', makeRepos);
}
