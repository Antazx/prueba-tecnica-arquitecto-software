import type { Pool } from "pg";
import type { Delivery } from "../../application/messages.ts";

export function postgresOutbox(pool: Pool) {
  return {
    async ready(): Promise<Delivery[]> {
      const result = await pool.query<{ id: string; event_id: string; consumer: Delivery["consumer"]; cycle: number; attempt: number }>(`SELECT id,event_id,consumer,cycle,attempt
        FROM scheduling.outbox_publications WHERE published_at IS NULL AND available_at <= clock_timestamp()
        ORDER BY available_at,created_at,id LIMIT 20`);
      return result.rows.map((row) => ({ version: 1, publicationId: row.id, eventId: row.event_id, consumer: row.consumer, cycle: row.cycle, attempt: row.attempt }));
    },
    async published(publicationId: string) {
      await pool.query("UPDATE scheduling.outbox_publications SET published_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1 AND published_at IS NULL", [publicationId]);
    },
  };
}
