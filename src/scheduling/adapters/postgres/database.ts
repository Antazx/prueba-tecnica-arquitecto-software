import { Pool } from "pg";

export function createDatabasePool(connectionString: string) {
  return new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    query_timeout: 3000,
  });
}

export async function checkDatabase(pool: Pool): Promise<void> {
  const result = await pool.query<{ ready: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'scheduling') AS ready",
  );
  if (!result.rows[0]?.ready) throw new Error("The scheduling schema is not initialized");
}
