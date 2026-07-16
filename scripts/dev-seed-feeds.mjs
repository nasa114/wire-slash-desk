// 開発環境用: フィードを初期投入する(既存データは全削除)。
// 使い方: node scripts/dev-seed-feeds.mjs [--force]
// 対象は squid の許可ドメイン(.github.com)内の Releases Atom フィード。
//
// 安全ガード: 接続先 DB 名が開発 DB(app)でない場合は --force がない限り実行しない。
// truncate は任意 DB のデータを破壊するため、誤接続を防ぐ。
import pg from 'pg';

const EXPECTED_DB = 'app';
const force = process.argv.includes('--force');

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

// 実行前に必ず対象 DB 名を表示する。
const { rows } = await c.query('select current_database() as db');
const dbName = rows[0].db;
console.log(`Target database: ${dbName}`);

if (dbName !== EXPECTED_DB && !force) {
  console.error(
    `Refusing to seed: connected database "${dbName}" is not the dev database "${EXPECTED_DB}".`,
  );
  console.error('This script TRUNCATEs articles and feeds. Pass --force to override intentionally.');
  await c.end();
  process.exit(1);
}

try {
  // truncate + insert を 1 トランザクションで包み、途中失敗時は全て巻き戻す。
  await c.query('begin');
  await c.query('truncate articles, feeds cascade');
  await c.query(
    `insert into feeds (name, feed_url, site_url, translate) values
       ($1, $2, $3, true),
       ($4, $5, $6, true)`,
    [
      'Node.js Releases',
      'https://github.com/nodejs/node/releases.atom',
      'https://github.com/nodejs/node',
      'Claude Code Releases',
      'https://github.com/anthropics/claude-code/releases.atom',
      'https://github.com/anthropics/claude-code',
    ],
  );
  await c.query('commit');
  console.log('seeded 2 real feeds');
} catch (err) {
  await c.query('rollback');
  throw err;
} finally {
  await c.end();
}
