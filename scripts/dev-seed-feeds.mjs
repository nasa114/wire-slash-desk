// 開発環境用: フィードを初期投入する(既存データは全削除)。
// 使い方: node scripts/dev-seed-feeds.mjs
// 対象は squid の許可ドメイン(.github.com)内の Releases Atom フィード。
import pg from 'pg';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
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
console.log('seeded 2 real feeds');
await c.end();
