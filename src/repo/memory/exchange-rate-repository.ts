import type { ExchangeRate } from '../../domain/types.ts';
import type { ExchangeRateRepository } from '../../domain/repositories.ts';
import { cloneExchangeRate, type MemoryStore } from './store.ts';

export class MemoryExchangeRateRepository implements ExchangeRateRepository {
  private readonly store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  async get(pair: string): Promise<ExchangeRate | null> {
    const rate = this.store.exchangeRates.get(pair);
    return rate ? cloneExchangeRate(rate) : null;
  }

  async upsert(input: ExchangeRate): Promise<void> {
    this.store.exchangeRates.set(input.pair, cloneExchangeRate(input));
  }
}
