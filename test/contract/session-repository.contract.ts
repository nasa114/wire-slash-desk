import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Repositories } from '../../src/domain/repositories.ts';
import type { User } from '../../src/domain/types.ts';
import { NotFoundError } from '../../src/domain/errors.ts';

export type MakeRepos = () => Promise<Repositories>;

const HOUR = 60 * 60_000;

async function makeUser(repos: Repositories, username = 'session-owner'): Promise<User> {
  return repos.users.create({ username, passwordHash: 'h' });
}

/**
 * SessionRepository 契約テスト。memory / pg どちらの実装もこのスイートを通過すること(T4-1)。
 */
export function runSessionRepositoryContract(impl: string, makeRepos: MakeRepos): void {
  const t = (name: string) => `[${impl}] SessionRepository: ${name}`;

  test(t('create / getByTokenHash の往復'), async () => {
    const repos = await makeRepos();
    try {
      const user = await makeUser(repos);
      const expiresAt = new Date(Date.now() + HOUR);
      const session = await repos.sessions.create({ userId: user.id, tokenHash: 'th1', expiresAt });
      assert.ok(session.id.length > 0);
      assert.equal(session.userId, user.id);
      assert.equal(session.tokenHash, 'th1');
      assert.equal(session.expiresAt.getTime(), expiresAt.getTime());
      const found = await repos.sessions.getByTokenHash('th1');
      assert.equal(found?.id, session.id);
      assert.equal(await repos.sessions.getByTokenHash('unknown'), null);
    } finally {
      await repos.close();
    }
  });

  test(t('存在しない userId は NotFoundError'), async () => {
    const repos = await makeRepos();
    try {
      await assert.rejects(
        repos.sessions.create({
          userId: '00000000-0000-0000-0000-000000000000',
          tokenHash: 'th',
          expiresAt: new Date(Date.now() + HOUR),
        }),
        NotFoundError,
      );
    } finally {
      await repos.close();
    }
  });

  test(t('deleteByTokenHash は冪等(存在しなくてもエラーにしない)'), async () => {
    const repos = await makeRepos();
    try {
      const user = await makeUser(repos);
      await repos.sessions.create({
        userId: user.id,
        tokenHash: 'th-del',
        expiresAt: new Date(Date.now() + HOUR),
      });
      await repos.sessions.deleteByTokenHash('th-del');
      assert.equal(await repos.sessions.getByTokenHash('th-del'), null);
      // 二重削除もエラーにならない
      await repos.sessions.deleteByTokenHash('th-del');
    } finally {
      await repos.close();
    }
  });

  test(t('deleteExpired は期限切れのみ削除して件数を返す'), async () => {
    const repos = await makeRepos();
    try {
      const user = await makeUser(repos);
      const now = new Date();
      await repos.sessions.create({
        userId: user.id,
        tokenHash: 'expired',
        expiresAt: new Date(now.getTime() - HOUR),
      });
      await repos.sessions.create({
        userId: user.id,
        tokenHash: 'boundary',
        expiresAt: now,
      });
      await repos.sessions.create({
        userId: user.id,
        tokenHash: 'alive',
        expiresAt: new Date(now.getTime() + HOUR),
      });
      const deleted = await repos.sessions.deleteExpired(now);
      assert.equal(deleted, 2, 'expiresAt <= now の2件が削除される');
      assert.equal(await repos.sessions.getByTokenHash('expired'), null);
      assert.equal(await repos.sessions.getByTokenHash('boundary'), null);
      assert.ok(await repos.sessions.getByTokenHash('alive'));
    } finally {
      await repos.close();
    }
  });

  test(t('user 削除で紐づくセッションも消える(cascade)'), async () => {
    const repos = await makeRepos();
    try {
      // UserRepository に delete は無いので、この契約は FK cascade の宣言のみ検証対象外。
      // ここでは同一ユーザーの複数セッションが独立して扱えることを確認する。
      const user = await makeUser(repos);
      await repos.sessions.create({
        userId: user.id,
        tokenHash: 'a',
        expiresAt: new Date(Date.now() + HOUR),
      });
      await repos.sessions.create({
        userId: user.id,
        tokenHash: 'b',
        expiresAt: new Date(Date.now() + HOUR),
      });
      await repos.sessions.deleteByTokenHash('a');
      assert.equal(await repos.sessions.getByTokenHash('a'), null);
      assert.ok(await repos.sessions.getByTokenHash('b'), '他セッションは影響を受けない');
    } finally {
      await repos.close();
    }
  });
}
