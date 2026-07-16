import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Repositories } from '../../src/domain/repositories.ts';
import type { Feed } from '../../src/domain/types.ts';
import { NotFoundError } from '../../src/domain/errors.ts';
import type { MakeRepos } from './feed-repository.contract.ts';

async function seedFeed(repos: Repositories, url = 'https://seed.example.com/rss'): Promise<Feed> {
  return repos.feeds.create({ name: 'seed', feedUrl: url });
}

/**
 * ArticleRepository 契約テスト。memory / pg どちらの実装もこのスイートを通過すること(T1-2)。
 */
export function runArticleRepositoryContract(impl: string, makeRepos: MakeRepos): void {
  const t = (name: string) => `[${impl}] ArticleRepository: ${name}`;

  test(t('upsertMany は挿入し、(feedId, guid) 重複は上書きせずスキップする'), async () => {
    const repos = await makeRepos();
    try {
      const feed = await seedFeed(repos);
      const first = await repos.articles.upsertMany([
        { feedId: feed.id, guid: 'g1', title: 'original title', url: 'https://s.example.com/1' },
        { feedId: feed.id, guid: 'g2', title: 't2', url: 'https://s.example.com/2' },
      ]);
      assert.deepEqual(first, { inserted: 2, skipped: 0 });

      // 同じ guid をタイトルを変えて再投入 → スキップされ、既存タイトルは変わらない
      const second = await repos.articles.upsertMany([
        { feedId: feed.id, guid: 'g1', title: 'CHANGED', url: 'https://s.example.com/1' },
        { feedId: feed.id, guid: 'g3', title: 't3', url: 'https://s.example.com/3' },
      ]);
      assert.deepEqual(second, { inserted: 1, skipped: 1 });

      const all = await repos.articles.listRecent({ feedId: feed.id });
      assert.equal(all.length, 3);
      const g1 = all.find((a) => a.guid === 'g1');
      assert.equal(g1?.title, 'original title');
    } finally {
      await repos.close();
    }
  });

  test(t('収集経路で保存された記事の content は常に null(不変条件)'), async () => {
    const repos = await makeRepos();
    try {
      const feed = await seedFeed(repos);
      await repos.articles.upsertMany([
        { feedId: feed.id, guid: 'g1', title: 't1', url: 'https://s.example.com/1', lang: 'en' },
      ]);
      const [a] = await repos.articles.listRecent({ feedId: feed.id });
      assert.equal(a?.content, null);
      assert.equal(a?.lang, 'en');
      assert.ok(a?.fetchedAt instanceof Date);
    } finally {
      await repos.close();
    }
  });

  test(t('upsertMany: 未知の feedId は NotFoundError'), async () => {
    const repos = await makeRepos();
    try {
      await assert.rejects(
        repos.articles.upsertMany([
          { feedId: '00000000-0000-0000-0000-000000000000', guid: 'g', title: 't', url: 'https://x/1' },
        ]),
        NotFoundError,
      );
    } finally {
      await repos.close();
    }
  });

  test(t('listRecent: since / feedId で絞り込み、publishedAt 降順で返す'), async () => {
    const repos = await makeRepos();
    try {
      const f1 = await seedFeed(repos, 'https://f1.example.com/rss');
      const f2 = await seedFeed(repos, 'https://f2.example.com/rss');
      await repos.articles.upsertMany([
        { feedId: f1.id, guid: 'old', title: 'old', url: 'https://f1/1', publishedAt: new Date('2026-07-01T00:00:00Z') },
        { feedId: f1.id, guid: 'mid', title: 'mid', url: 'https://f1/2', publishedAt: new Date('2026-07-10T00:00:00Z') },
        { feedId: f2.id, guid: 'new', title: 'new', url: 'https://f2/1', publishedAt: new Date('2026-07-15T00:00:00Z') },
      ]);

      const all = await repos.articles.listRecent();
      assert.deepEqual(
        all.map((a) => a.guid),
        ['new', 'mid', 'old'],
      );

      const sinceFiltered = await repos.articles.listRecent({ since: new Date('2026-07-05T00:00:00Z') });
      assert.deepEqual(sinceFiltered.map((a) => a.guid).sort(), ['mid', 'new']);

      const f1Only = await repos.articles.listRecent({ feedId: f1.id });
      assert.deepEqual(f1Only.map((a) => a.guid).sort(), ['mid', 'old']);
    } finally {
      await repos.close();
    }
  });

  test(t('listRecent: limit 既定 50・上限 200'), async () => {
    const repos = await makeRepos();
    try {
      const feed = await seedFeed(repos);
      const items = Array.from({ length: 60 }, (_, i) => ({
        feedId: feed.id,
        guid: `g${i}`,
        title: `t${i}`,
        url: `https://s.example.com/${i}`,
        publishedAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      }));
      await repos.articles.upsertMany(items);

      assert.equal((await repos.articles.listRecent()).length, 50);
      assert.equal((await repos.articles.listRecent({ limit: 10 })).length, 10);
      assert.equal((await repos.articles.listRecent({ limit: 10_000 })).length, 60, 'limit は 200 に丸められる(データが 60 件なら全件)');
    } finally {
      await repos.close();
    }
  });

  test(t('searchByTitle: 大文字小文字を無視した部分一致'), async () => {
    const repos = await makeRepos();
    try {
      const feed = await seedFeed(repos);
      await repos.articles.upsertMany([
        { feedId: feed.id, guid: 'g1', title: 'PostgreSQL 17 Released', url: 'https://s/1' },
        { feedId: feed.id, guid: 'g2', title: 'security advisory: openssl', url: 'https://s/2' },
        { feedId: feed.id, guid: 'g3', title: 'unrelated', url: 'https://s/3' },
      ]);
      const hits = await repos.articles.searchByTitle('POSTGRESQL');
      assert.equal(hits.length, 1);
      assert.equal(hits[0]?.guid, 'g1');
      assert.equal((await repos.articles.searchByTitle('nomatch-xyz')).length, 0);
    } finally {
      await repos.close();
    }
  });

  test(t('searchByTitle: feedId オプションでフィード内に絞り込める'), async () => {
    const repos = await makeRepos();
    try {
      const f1 = await seedFeed(repos, 'https://sf1.example.com/rss');
      const f2 = await seedFeed(repos, 'https://sf2.example.com/rss');
      await repos.articles.upsertMany([
        { feedId: f1.id, guid: 'g1', title: 'release notes v1', url: 'https://sf1/1' },
        { feedId: f2.id, guid: 'g2', title: 'release notes v2', url: 'https://sf2/1' },
      ]);
      const all = await repos.articles.searchByTitle('release');
      assert.equal(all.length, 2);
      const onlyF1 = await repos.articles.searchByTitle('release', { feedId: f1.id });
      assert.equal(onlyF1.length, 1);
      assert.equal(onlyF1[0]?.guid, 'g1');
      const limited = await repos.articles.searchByTitle('release', { feedId: f2.id, limit: 1 });
      assert.equal(limited[0]?.guid, 'g2');
    } finally {
      await repos.close();
    }
  });

  test(t('listByDate: UTC 日付で publishedAt を照合する'), async () => {
    const repos = await makeRepos();
    try {
      const feed = await seedFeed(repos);
      await repos.articles.upsertMany([
        { feedId: feed.id, guid: 'in1', title: 'day start', url: 'https://s/1', publishedAt: new Date('2026-07-15T00:00:00Z') },
        { feedId: feed.id, guid: 'in2', title: 'day end', url: 'https://s/2', publishedAt: new Date('2026-07-15T23:59:59Z') },
        { feedId: feed.id, guid: 'out1', title: 'day before', url: 'https://s/3', publishedAt: new Date('2026-07-14T23:59:59Z') },
        { feedId: feed.id, guid: 'out2', title: 'day after', url: 'https://s/4', publishedAt: new Date('2026-07-16T00:00:00Z') },
        { feedId: feed.id, guid: 'nodate', title: 'no date', url: 'https://s/5' },
      ]);
      const hits = await repos.articles.listByDate('2026-07-15');
      assert.deepEqual(hits.map((a) => a.guid).sort(), ['in1', 'in2']);
    } finally {
      await repos.close();
    }
  });

  test(t('getById / setContent(明示操作でのみ本文格納)'), async () => {
    const repos = await makeRepos();
    try {
      const feed = await seedFeed(repos);
      await repos.articles.upsertMany([{ feedId: feed.id, guid: 'g1', title: 't1', url: 'https://s/1' }]);
      const [a] = await repos.articles.listRecent({ feedId: feed.id });
      assert.ok(a);
      assert.equal((await repos.articles.getById(a.id))?.guid, 'g1');
      assert.equal(await repos.articles.getById('00000000-0000-0000-0000-000000000000'), null);

      await repos.articles.setContent(a.id, 'fetched body text');
      assert.equal((await repos.articles.getById(a.id))?.content, 'fetched body text');

      await assert.rejects(
        repos.articles.setContent('00000000-0000-0000-0000-000000000000', 'x'),
        NotFoundError,
      );
    } finally {
      await repos.close();
    }
  });
}
