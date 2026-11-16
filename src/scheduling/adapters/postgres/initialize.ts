import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { validateAgenda, type AgendaInterval } from "../../domain/agenda.ts";

export async function initializeDatabase(pool: Pool): Promise<void> {
  const schema = await readFile(new URL("../../../../db/schema.sql", import.meta.url), "utf8");
  const seed = await readFile(new URL("../../../../db/seed.sql", import.meta.url), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Only bootstrap uses this lock; business coordination belongs to each scope.
    await client.query("SELECT pg_advisory_xact_lock(478812904)");
    await client.query(schema);
    await client.query(seed);
    const result = await client.query<AgendaInterval>(`
      SELECT id, resource_id AS "resourceId",
             (extract(epoch FROM starts_at) * 1000)::double precision AS "startsAt",
             (extract(epoch FROM ends_at) * 1000)::double precision AS "endsAt"
      FROM scheduling.slots
    `);
    validateAgenda(result.rows);
    await client.query("UPDATE scheduling.demo_seed SET validated = true WHERE singleton AND NOT validated");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
