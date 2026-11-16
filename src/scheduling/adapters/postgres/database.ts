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
    "SELECT validated AS ready FROM scheduling.demo_seed WHERE singleton",
  );
  if (!result.rows[0]?.ready) throw new Error("The scheduling agenda is not initialized and validated");
}
