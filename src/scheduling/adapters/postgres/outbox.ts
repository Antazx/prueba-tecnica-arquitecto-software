import type { Pool } from "pg";
import type { Delivery } from "../../application/messages.ts";
import type { Outbox } from "../../application/outbox.ts";

export function postgresOutbox(pool: Pool): Outbox {
  return {
    async ready(): Promise<Delivery[]> {
      const result = await pool.query<{ id: string; event_id: string; consumer: Delivery["consumer"]; cycle: number; attempt: number }>(`SELECT p.id,p.event_id,p.consumer,p.cycle,p.attempt
        FROM scheduling.outbox_publications p
        LEFT JOIN scheduling.consumer_attempts a USING (event_id,consumer,cycle,attempt)
        WHERE p.published_at IS NULL AND GREATEST(p.available_at,p.next_attempt_at) <= clock_timestamp()
          AND (a.not_before IS NULL OR a.not_before <= clock_timestamp())
        ORDER BY GREATEST(p.available_at,p.next_attempt_at,a.not_before),p.created_at,p.id LIMIT 20`);
      return result.rows.map((row) => ({ version: 1, publicationId: row.id, eventId: row.event_id, consumer: row.consumer, cycle: row.cycle, attempt: row.attempt }));
    },
    async started(publicationId, retryDelayMs) {
      // Persist a conservative next date before network I/O, including an uncertain crash.
      const result = await pool.query(`WITH time AS (SELECT date_trunc('milliseconds',clock_timestamp()) AS now)
        UPDATE scheduling.outbox_publications p SET send_count=send_count+1,last_attempt_at=time.now,
          next_attempt_at=GREATEST(p.available_at,time.now+($2*interval '1 millisecond')) FROM time
        WHERE p.id=$1 AND p.published_at IS NULL AND GREATEST(p.available_at,p.next_attempt_at) <= time.now
          AND NOT EXISTS (SELECT 1 FROM scheduling.consumer_attempts a WHERE a.event_id=p.event_id AND a.consumer=p.consumer
            AND a.cycle=p.cycle AND a.attempt=p.attempt AND a.not_before > time.now)`, [publicationId, retryDelayMs]);
      return result.rowCount === 1;
    },
    async failed(publicationId, error, retryDelayMs) {
      await pool.query(`UPDATE scheduling.outbox_publications SET last_error=$2,
        next_attempt_at=GREATEST(available_at,date_trunc('milliseconds',clock_timestamp())+($3*interval '1 millisecond'))
        WHERE id=$1 AND published_at IS NULL`, [publicationId, error, retryDelayMs]);
    },
    async published(publicationId: string) {
      await pool.query("UPDATE scheduling.outbox_publications SET published_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1 AND published_at IS NULL", [publicationId]);
    },
  };
}
