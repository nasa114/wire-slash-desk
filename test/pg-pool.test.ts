import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPgPool } from '../src/repo/pg/pool.ts';

// Neon 等の自動サスペンドする PostgreSQL では、アイドル接続がサーバー側から切断される。
// node-postgres の Pool はこれを 'error' イベントとして発火するため、リスナーが
// 無いと Node.js プロセスごとクラッシュする。ここではその安全弁を検証する。

test('createPgPool: error リスナーが1つ登録されている', async () => {
  const pool = createPgPool('postgresql://user:secret@localhost:5432/db');
  assert.equal(pool.listenerCount('error'), 1);
  await pool.end();
});

test('createPgPool: アイドル接続の error イベントで例外にならず onIdleClientError に通知される', async () => {
  const errors: Error[] = [];
  const pool = createPgPool('postgresql://user:secret@localhost:5432/db', {
    onIdleClientError: (err) => errors.push(err),
  });
  pool.emit('error', new Error('Connection terminated unexpectedly'));
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /Connection terminated unexpectedly/);
  await pool.end();
});

test('createPgPool: 既定ハンドラでも emit がクラッシュしない', async () => {
  const pool = createPgPool('postgresql://user:secret@localhost:5432/db');
  // リスナー未登録の EventEmitter への 'error' emit は throw する。
  // 既定ハンドラ(console.error)が登録済みであれば throw しない。
  assert.doesNotThrow(() => pool.emit('error', new Error('boom')));
  await pool.end();
});
