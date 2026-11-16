import type { Pool } from "pg";
import type { AgendaSnapshot, SlotQuery } from "../../application/agenda.ts";

interface SlotRow {
  evaluated_at: Date;
  id: string | null;
  resource_id: string;
  hospital_id: string;
  test_type_id: string;
  starts_at: Date;
  ends_at: Date;
}

export async function listSlots(pool: Pool, query: SlotQuery): Promise<AgendaSnapshot> {
  // One statement shares both the snapshot and the PostgreSQL evaluation time.
  const result = await pool.query<SlotRow>(`
    WITH evaluation AS MATERIALIZED (
      SELECT date_trunc('milliseconds', statement_timestamp()) AS at
    )
    SELECT e.at AS evaluated_at, s.id, s.resource_id, s.hospital_id,
           s.test_type_id, s.starts_at, s.ends_at
    FROM evaluation e
    LEFT JOIN scheduling.slots s
      ON s.hospital_id = $1 AND s.test_type_id = $2
      AND s.starts_at >= $3 AND s.starts_at < $4 AND s.starts_at > e.at
    ORDER BY s.starts_at, s.id
  `, [query.hospitalId, query.testTypeId, query.from, query.to]);
  return {
    evaluatedAt: result.rows[0].evaluated_at.toISOString(),
    slots: result.rows.flatMap((row) => row.id === null ? [] : [{
      id: row.id,
      resourceId: row.resource_id,
      hospitalId: row.hospital_id,
      testTypeId: row.test_type_id,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      directlyBookable: true,
    }]),
  };
}
