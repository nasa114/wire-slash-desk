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
}
