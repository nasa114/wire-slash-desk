import type { Article, Feed, Session, User } from '../../domain/types.ts';

/** feeds/articles(および users/sessions)が cascade 削除を共有するための共通ストア。 */
export interface MemoryStore {
  feeds: Map<string, Feed>;
  articles: Map<string, Article>;
  users: Map<string, User>;
  sessions: Map<string, Session>;
}

export function createMemoryStore(): MemoryStore {
  return { feeds: new Map(), articles: new Map(), users: new Map(), sessions: new Map() };
}

/**
 * Date は参照型のため、shallow copy(`{ ...x }`)だけでは呼び出し側が
 * 返却値の Date を mutate すると内部状態まで書き換わってしまう。
 * 保存時・返却時の両方でこのヘルパーを通し、Date を都度複製して参照を切り離す。
 */
export function cloneArticle(article: Article): Article {
  return {
    ...article,
    publishedAt: article.publishedAt ? new Date(article.publishedAt) : null,
    fetchedAt: new Date(article.fetchedAt),
  };
}

export function cloneFeed(feed: Feed): Feed {
  return {
    ...feed,
    lastFetchedAt: feed.lastFetchedAt ? new Date(feed.lastFetchedAt) : null,
    createdAt: new Date(feed.createdAt),
    updatedAt: new Date(feed.updatedAt),
  };
}

export function cloneUser(user: User): User {
  return {
    ...user,
    createdAt: new Date(user.createdAt),
    updatedAt: new Date(user.updatedAt),
  };
}

export function cloneSession(session: Session): Session {
  return {
    ...session,
    expiresAt: new Date(session.expiresAt),
    createdAt: new Date(session.createdAt),
  };
}
