import pg, { type Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

export type DbClient = Pool | PoolClient;

export function createPool(databaseUrl: string): Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    // Avoid logging credentials via connectionString in error dumps from pg.
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback failures; original error is more important.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function query<T extends QueryResultRow>(
  db: DbClient,
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return db.query<T>(text, params);
}
