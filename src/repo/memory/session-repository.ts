import { randomUUID } from 'node:crypto';
import type { NewSession, Session } from '../../domain/types.ts';
import type { SessionRepository } from '../../domain/repositories.ts';
import { NotFoundError } from '../../domain/errors.ts';
import { cloneSession, type MemoryStore } from './store.ts';

export class MemorySessionRepository implements SessionRepository {
  private readonly store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  async create(input: NewSession): Promise<Session> {
    if (!this.store.users.has(input.userId)) throw new NotFoundError('user', input.userId);
    const session: Session = {
      id: randomUUID(),
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: new Date(input.expiresAt),
      createdAt: new Date(),
    };
    this.store.sessions.set(session.id, session);
    return cloneSession(session);
  }

  async getByTokenHash(tokenHash: string): Promise<Session | null> {
    for (const session of this.store.sessions.values()) {
      if (session.tokenHash === tokenHash) return cloneSession(session);
    }
    return null;
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    for (const [id, session] of this.store.sessions) {
      if (session.tokenHash === tokenHash) {
        this.store.sessions.delete(id);
        return;
      }
    }
  }

  async deleteExpired(now: Date): Promise<number> {
    let deleted = 0;
    for (const [id, session] of this.store.sessions) {
      if (session.expiresAt.getTime() <= now.getTime()) {
        this.store.sessions.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }
}
