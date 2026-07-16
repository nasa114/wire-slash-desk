import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Repositories } from '../../src/domain/repositories.ts';
import { DuplicateFeedUrlError, NotFoundError, ValidationError } from '../../src/domain/errors.ts';

export type MakeRepos = () => Promise<Repositories>;

const MIN = 60_000;

/**
 * FeedRepository 契約テスト。memory / pg どちらの実装もこのスイートを通過すること(T1-2)。
 */
export function runFeedRepositoryContract(impl: string, makeRepos: MakeRepos): void {
  const t = (name: string) => `[${impl}] FeedRepository: ${name}`;

  test(t('create はデフォルト値を補完した Feed を返す'), async () => {
    const repos = await makeRepos();
    try {
      const feed = await repos.feeds.create({ name: 'Example', feedUrl: 'https://example.com/rss' });
      assert.ok(feed.id.length > 0);
      assert.equal(feed.name, 'Example');
      assert.equal(feed.feedUrl, 'https://example.com/rss');
      assert.equal(feed.siteUrl, null);
      assert.equal(feed.fetchIntervalMinutes, 60);
      assert.equal(feed.translate, true);
      assert.equal(feed.fulltextAllowed, false);
      assert.equal(feed.enabled, true);
      assert.equal(feed.tosNote, null);
      assert.equal(feed.etag, null);
      assert.equal(feed.lastModified, null);
      assert.equal(feed.lastFetchedAt, null);
      assert.ok(feed.createdAt instanceof Date);
      assert.ok(feed.updatedAt instanceof Date);
    } finally {
      await repos.close();
    }
  });

  test(t('feedUrl 重複は DuplicateFeedUrlError'), async () => {
    const repos = await makeRepos();
    try {
      await repos.feeds.create({ name: 'A', feedUrl: 'https://dup.example.com/rss' });
      await assert.rejects(
        repos.feeds.create({ name: 'B', feedUrl: 'https://dup.example.com/rss' }),
        DuplicateFeedUrlError,
      );
    } finally {
      await repos.close();
    }
  });

  test(t('fetchIntervalMinutes < 15 は ValidationError'), async () => {
    const repos = await makeRepos();
    try {
      await assert.rejects(
        repos.feeds.create({ name: 'A', feedUrl: 'https://x.example.com/rss', fetchIntervalMinutes: 5 }),
        ValidationError,
      );
    } finally {
      await repos.close();
    }
  });

  test(t('getById / getByFeedUrl は存在しなければ null'), async () => {
    const repos = await makeRepos();
    try {
      assert.equal(await repos.feeds.getById('00000000-0000-0000-0000-000000000000'), null);
      assert.equal(await repos.feeds.getByFeedUrl('https://none.example.com/rss'), null);
      const created = await repos.feeds.create({ name: 'A', feedUrl: 'https://a.example.com/rss' });
      const byId = await repos.feeds.getById(created.id);
      const byUrl = await repos.feeds.getByFeedUrl('https://a.example.com/rss');
      assert.equal(byId?.id, created.id);
      assert.equal(byUrl?.id, created.id);
    } finally {
      await repos.close();
    }
  });

  test(t('update はフィールドを更新し updatedAt を進める'), async () => {
    const repos = await makeRepos();
    try {
      const feed = await repos.feeds.create({ name: 'A', feedUrl: 'https://a.example.com/rss' });
      const updated = await repos.feeds.update(feed.id, {
        name: 'B',
        fulltextAllowed: true,
        tosNote: '2026-07-16 規約確認済み',
        fetchIntervalMinutes: 30,
      });
      assert.equal(updated.name, 'B');
      assert.equal(updated.fulltextAllowed, true);
      assert.equal(updated.tosNote, '2026-07-16 規約確認済み');
      assert.equal(updated.fetchIntervalMinutes, 30);
      assert.ok(updated.updatedAt.getTime() >= feed.updatedAt.getTime());
      // 未指定フィールドは維持される
      assert.equal(updated.feedUrl, feed.feedUrl);
      assert.equal(updated.enabled, true);
    } finally {
      await repos.close();
    }
  });

  test(t('update: 存在しない id は NotFoundError / interval < 15 は ValidationError'), async () => {
    const repos = await makeRepos();
    try {
      await assert.rejects(
        repos.feeds.update('00000000-0000-0000-0000-000000000000', { name: 'X' }),
        NotFoundError,
      );
      const feed = await repos.feeds.create({ name: 'A', feedUrl: 'https://a.example.com/rss' });
      await assert.rejects(repos.feeds.update(feed.id, { fetchIntervalMinutes: 1 }), ValidationError);
    } finally {
      await repos.close();
    }
  });

  test(t('listDue: 未取得は due / 直近取得済みは not due / 期限超過は due / 無効は常に not due'), async () => {
    const repos = await makeRepos();
    try {
      const now = new Date('2026-07-16T12:00:00Z');
      const never = await repos.feeds.create({ name: 'never', feedUrl: 'https://n.example.com/rss' });
      const fresh = await repos.feeds.create({
        name: 'fresh',
        feedUrl: 'https://f.example.com/rss',
        fetchIntervalMinutes: 60,
      });
      await repos.feeds.markFetched(fresh.id, new Date(now.getTime() - 10 * MIN));
      const overdue = await repos.feeds.create({
        name: 'overdue',
        feedUrl: 'https://o.example.com/rss',
        fetchIntervalMinutes: 60,
      });
      await repos.feeds.markFetched(overdue.id, new Date(now.getTime() - 61 * MIN));
      const disabled = await repos.feeds.create({
        name: 'disabled',
        feedUrl: 'https://d.example.com/rss',
        enabled: false,
      });

      const due = await repos.feeds.listDue(now);
      const ids = due.map((f) => f.id);
      assert.ok(ids.includes(never.id), 'never-fetched feed should be due');
      assert.ok(!ids.includes(fresh.id), 'recently fetched feed should not be due');
      assert.ok(ids.includes(overdue.id), 'overdue feed should be due');
      assert.ok(!ids.includes(disabled.id), 'disabled feed should never be due');
    } finally {
      await repos.close();
    }
  });

  test(t('listDue: 境界値(ちょうど interval 経過は due、1分前は not due)'), async () => {
    const repos = await makeRepos();
    try {
      const now = new Date('2026-07-16T12:00:00Z');
      const exact = await repos.feeds.create({
        name: 'exact',
        feedUrl: 'https://exact.example.com/rss',
        fetchIntervalMinutes: 60,
      });
      await repos.feeds.markFetched(exact.id, new Date(now.getTime() - 60 * MIN));

      const almost = await repos.feeds.create({
        name: 'almost',
        feedUrl: 'https://almost.example.com/rss',
        fetchIntervalMinutes: 60,
      });
      await repos.feeds.markFetched(almost.id, new Date(now.getTime() - 59 * MIN));

      const due = await repos.feeds.listDue(now);
      const ids = due.map((f) => f.id);
      assert.ok(ids.includes(exact.id), 'ちょうど interval 経過(lastFetchedAt + interval <= now)は due であること');
      assert.ok(!ids.includes(almost.id), '1分前(59分)に取得済みは due でないこと');
    } finally {
      await repos.close();
    }
  });

  test(t('Feed の Date 参照隔離: markFetched に渡した Date / 返却値の Date を mutate しても内部状態は不変'), async () => {
    const repos = await makeRepos();
    try {
      const feed = await repos.feeds.create({ name: 'A', feedUrl: 'https://iso.example.com/rss' });
      const fetchedAt = new Date('2026-07-16T00:00:00Z');
      await repos.feeds.markFetched(feed.id, fetchedAt);

      // markFetched に渡した Date を後から mutate → 保存値は不変であること
      fetchedAt.setFullYear(1999);
      const afterInputMutation = await repos.feeds.getById(feed.id);
      assert.equal(afterInputMutation?.lastFetchedAt?.getUTCFullYear(), 2026);

      // getById で得た Date を mutate → 再取得した値は不変であること
      afterInputMutation?.lastFetchedAt?.setFullYear(1900);
      const again = await repos.feeds.getById(feed.id);
      assert.equal(again?.lastFetchedAt?.getUTCFullYear(), 2026);
    } finally {
      await repos.close();
    }
  });

  test(t('markFetched は lastFetchedAt / etag / lastModified を更新する'), async () => {
    const repos = await makeRepos();
    try {
      const feed = await repos.feeds.create({ name: 'A', feedUrl: 'https://a.example.com/rss' });
      const at = new Date('2026-07-16T00:00:00Z');
      await repos.feeds.markFetched(feed.id, at, { etag: 'W/"abc"', lastModified: 'Wed, 16 Jul 2026 00:00:00 GMT' });
      const got = await repos.feeds.getById(feed.id);
      assert.equal(got?.lastFetchedAt?.getTime(), at.getTime());
      assert.equal(got?.etag, 'W/"abc"');
      assert.equal(got?.lastModified, 'Wed, 16 Jul 2026 00:00:00 GMT');

      // meta 省略(304 相当)では条件付きGETヘッダを保持したまま時刻のみ更新
      const at2 = new Date('2026-07-16T01:00:00Z');
      await repos.feeds.markFetched(feed.id, at2);
      const got2 = await repos.feeds.getById(feed.id);
      assert.equal(got2?.lastFetchedAt?.getTime(), at2.getTime());
      assert.equal(got2?.etag, 'W/"abc"');
    } finally {
      await repos.close();
    }
  });

  test(t('delete はフィードと配下の記事を削除する(cascade)'), async () => {
    const repos = await makeRepos();
    try {
      const feed = await repos.feeds.create({ name: 'A', feedUrl: 'https://a.example.com/rss' });
      await repos.articles.upsertMany([
        { feedId: feed.id, guid: 'g1', title: 't1', url: 'https://a.example.com/1' },
      ]);
      await repos.feeds.delete(feed.id);
      assert.equal(await repos.feeds.getById(feed.id), null);
      const remaining = await repos.articles.listRecent({ feedId: feed.id });
      assert.equal(remaining.length, 0);
    } finally {
      await repos.close();
    }
  });
}
