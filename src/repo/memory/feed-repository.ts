import { randomUUID } from 'node:crypto';
import type { Feed, FeedPatch, NewFeed } from '../../domain/types.ts';
import type { FeedRepository } from '../../domain/repositories.ts';
import { DuplicateFeedUrlError, NotFoundError, ValidationError } from '../../domain/errors.ts';
import type { MemoryStore } from './store.ts';

const MIN_INTERVAL_MINUTES = 15;

function assertValidInterval(minutes: number): void {
  if (minutes < MIN_INTERVAL_MINUTES) {
    throw new ValidationError(`fetch_interval_minutes must be >= ${MIN_INTERVAL_MINUTES}`);
  }
}

export class MemoryFeedRepository implements FeedRepository {
  private readonly store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  async create(input: NewFeed): Promise<Feed> {
    const interval = input.fetchIntervalMinutes ?? 60;
    assertValidInterval(interval);
    for (const feed of this.store.feeds.values()) {
      if (feed.feedUrl === input.feedUrl) throw new DuplicateFeedUrlError(input.feedUrl);
    }
    const now = new Date();
    const feed: Feed = {
      id: randomUUID(),
      name: input.name,
      feedUrl: input.feedUrl,
      siteUrl: input.siteUrl ?? null,
      fetchIntervalMinutes: interval,
      translate: input.translate ?? true,
      fulltextAllowed: input.fulltextAllowed ?? false,
      enabled: input.enabled ?? true,
      tosNote: input.tosNote ?? null,
      etag: null,
      lastModified: null,
      lastFetchedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.feeds.set(feed.id, feed);
    return { ...feed };
  }

  async getById(id: string): Promise<Feed | null> {
    const feed = this.store.feeds.get(id);
    return feed ? { ...feed } : null;
  }

  async getByFeedUrl(feedUrl: string): Promise<Feed | null> {
    for (const feed of this.store.feeds.values()) {
      if (feed.feedUrl === feedUrl) return { ...feed };
    }
    return null;
  }

  async list(): Promise<Feed[]> {
    return [...this.store.feeds.values()].map((f) => ({ ...f }));
  }

  async listDue(now: Date): Promise<Feed[]> {
    return [...this.store.feeds.values()]
      .filter((f) => {
        if (!f.enabled) return false;
        if (f.lastFetchedAt === null) return true;
        return f.lastFetchedAt.getTime() + f.fetchIntervalMinutes * 60_000 <= now.getTime();
      })
      .map((f) => ({ ...f }));
  }

  async update(id: string, patch: FeedPatch): Promise<Feed> {
    const feed = this.store.feeds.get(id);
    if (!feed) throw new NotFoundError('feed', id);
    if (patch.fetchIntervalMinutes !== undefined) assertValidInterval(patch.fetchIntervalMinutes);
    if (patch.feedUrl !== undefined && patch.feedUrl !== feed.feedUrl) {
      for (const other of this.store.feeds.values()) {
        if (other.id !== id && other.feedUrl === patch.feedUrl) {
          throw new DuplicateFeedUrlError(patch.feedUrl);
        }
      }
    }
    const updated: Feed = {
      ...feed,
      name: patch.name ?? feed.name,
      feedUrl: patch.feedUrl ?? feed.feedUrl,
      siteUrl: patch.siteUrl !== undefined ? patch.siteUrl : feed.siteUrl,
      fetchIntervalMinutes: patch.fetchIntervalMinutes ?? feed.fetchIntervalMinutes,
      translate: patch.translate ?? feed.translate,
      fulltextAllowed: patch.fulltextAllowed ?? feed.fulltextAllowed,
      enabled: patch.enabled ?? feed.enabled,
      tosNote: patch.tosNote !== undefined ? patch.tosNote : feed.tosNote,
      updatedAt: new Date(),
    };
    this.store.feeds.set(id, updated);
    return { ...updated };
  }

  async markFetched(
    id: string,
    fetchedAt: Date,
    meta?: { etag?: string | null; lastModified?: string | null },
  ): Promise<void> {
    const feed = this.store.feeds.get(id);
    if (!feed) throw new NotFoundError('feed', id);
    const updated: Feed = {
      ...feed,
      lastFetchedAt: fetchedAt,
      etag: meta?.etag !== undefined ? meta.etag : feed.etag,
      lastModified: meta?.lastModified !== undefined ? meta.lastModified : feed.lastModified,
      updatedAt: new Date(),
    };
    this.store.feeds.set(id, updated);
  }

  async delete(id: string): Promise<void> {
    if (!this.store.feeds.delete(id)) throw new NotFoundError('feed', id);
    for (const [articleId, article] of this.store.articles) {
      if (article.feedId === id) this.store.articles.delete(articleId);
    }
  }
}
