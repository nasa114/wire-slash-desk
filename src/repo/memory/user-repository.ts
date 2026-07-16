import { randomUUID } from 'node:crypto';
import type { NewUser, User } from '../../domain/types.ts';
import type { UserRepository } from '../../domain/repositories.ts';
import { DuplicateUsernameError } from '../../domain/errors.ts';
import { cloneUser, type MemoryStore } from './store.ts';

export class MemoryUserRepository implements UserRepository {
  private readonly store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  async create(input: NewUser): Promise<User> {
    for (const user of this.store.users.values()) {
      if (user.username === input.username) throw new DuplicateUsernameError(input.username);
    }
    const createdAt = new Date();
    const user: User = {
      id: randomUUID(),
      username: input.username,
      passwordHash: input.passwordHash,
      createdAt,
      updatedAt: new Date(createdAt),
    };
    this.store.users.set(user.id, user);
    return cloneUser(user);
  }

  async getById(id: string): Promise<User | null> {
    const user = this.store.users.get(id);
    return user ? cloneUser(user) : null;
  }

  async getByUsername(username: string): Promise<User | null> {
    for (const user of this.store.users.values()) {
      if (user.username === username) return cloneUser(user);
    }
    return null;
  }

  async count(): Promise<number> {
    return this.store.users.size;
  }
}
