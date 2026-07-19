import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Repositories } from '../../src/domain/repositories.ts';
import { DuplicateUsernameError } from '../../src/domain/errors.ts';

export type MakeRepos = () => Promise<Repositories>;

/**
 * UserRepository 契約テスト。memory / pg どちらの実装もこのスイートを通過すること(T4-1)。
 */
export function runUserRepositoryContract(impl: string, makeRepos: MakeRepos): void {
  const t = (name: string) => `[${impl}] UserRepository: ${name}`;

  test(t('create は User を返し、count が増える'), async () => {
    const repos = await makeRepos();
    try {
      assert.equal(await repos.users.count(), 0);
      const user = await repos.users.create({ username: 'alice', passwordHash: 'scrypt$x' });
      assert.ok(user.id.length > 0);
      assert.equal(user.username, 'alice');
      assert.equal(user.passwordHash, 'scrypt$x');
      assert.ok(user.createdAt instanceof Date);
      assert.ok(user.updatedAt instanceof Date);
      assert.equal(await repos.users.count(), 1);
    } finally {
      await repos.close();
    }
  });

  test(t('username 重複は DuplicateUsernameError'), async () => {
    const repos = await makeRepos();
    try {
      await repos.users.create({ username: 'alice', passwordHash: 'h1' });
      await assert.rejects(
        repos.users.create({ username: 'alice', passwordHash: 'h2' }),
        DuplicateUsernameError,
      );
    } finally {
      await repos.close();
    }
  });

  test(t('getById / getByUsername は存在しなければ null'), async () => {
    const repos = await makeRepos();
    try {
      assert.equal(await repos.users.getById('00000000-0000-0000-0000-000000000000'), null);
      assert.equal(await repos.users.getByUsername('nobody'), null);
      const created = await repos.users.create({ username: 'bob', passwordHash: 'h' });
      assert.equal((await repos.users.getById(created.id))?.username, 'bob');
      assert.equal((await repos.users.getByUsername('bob'))?.id, created.id);
    } finally {
      await repos.close();
    }
  });

  test(t('createInitial は users が空のときだけ作成し、2回目以降は null(原子的 first-run)'), async () => {
    const repos = await makeRepos();
    try {
      const first = await repos.users.createInitial({ username: 'owner', passwordHash: 'h1' });
      assert.ok(first, '空のときは User を返す');
      assert.equal(first?.username, 'owner');
      assert.equal(await repos.users.count(), 1);
      // 既に1件あるので2回目は作成されず null。
      const second = await repos.users.createInitial({ username: 'intruder', passwordHash: 'h2' });
      assert.equal(second, null, '既存ユーザーがいれば作成しない');
      assert.equal(await repos.users.count(), 1, '件数は増えない');
      assert.equal(await repos.users.getByUsername('intruder'), null);
    } finally {
      await repos.close();
    }
  });

  test(t('createInitial の並行呼び出しでも作成されるのは1件だけ(TOCTOU)'), async () => {
    const repos = await makeRepos();
    try {
      const attempts = Array.from({ length: 8 }, (_, i) =>
        repos.users.createInitial({ username: `race${i}`, passwordHash: 'h' }),
      );
      const results = await Promise.all(attempts);
      const created = results.filter((r) => r !== null);
      assert.equal(created.length, 1, '同時 first-run でも1件のみ作成される');
      assert.equal(await repos.users.count(), 1);
    } finally {
      await repos.close();
    }
  });
}
