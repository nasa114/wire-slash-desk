import type { Pool } from 'pg';
import type { ExchangeRate } from '../../domain/types.ts';
import type { ExchangeRateRepository } from '../../domain/repositories.ts';
import { mapExchangeRateRow, type ExchangeRateRow } from './mappers.ts';

export class PgExchangeRateRepository implements ExchangeRateRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async get(pair: string): Promise<ExchangeRate | null> {
    const result = await this.pool.query<ExchangeRateRow>(
      `select * from exchange_rates where pair = $1`,
      [pair],
    );
    const row = result.rows[0];
    return row ? mapExchangeRateRow(row) : null;
  }

  async upsert(input: ExchangeRate): Promise<void> {
    await this.pool.query(
      `insert into exchange_rates (pair, rate, prev_close, market_time, fetched_at)
       values ($1, $2, $3, $4, $5)
       on conflict (pair) do update set
         rate = excluded.rate,
         prev_close = excluded.prev_close,
         market_time = excluded.market_time,
         fetched_at = excluded.fetched_at`,
      [input.pair, input.rate, input.prevClose, input.marketTime, input.fetchedAt],
    );
  }
}
