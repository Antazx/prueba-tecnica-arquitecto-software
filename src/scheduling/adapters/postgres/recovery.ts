import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { SchedulingTransaction } from "../../application/scheduling.ts";
import type { RecoveryResult } from "../../application/recovery.ts";
import type { Delivery } from "../../application/messages.ts";

export async function readRecoveryPublication(pool: Pool, publicationId: string): Promise<Delivery> {
  const row = (await pool.query<{ event_id: string; consumer: Delivery["consumer"]; cycle: number; attempt: number; destination: string }>(
    "SELECT event_id,consumer,cycle,attempt,destination FROM scheduling.outbox_publications WHERE id=$1", [publicationId])).rows[0];
  if (!row) throw new Error("Selected retained publication does not exist");
  return { version: 1, publicationId, eventId: row.event_id, consumer: row.consumer, cycle: row.cycle, attempt: row.attempt,
    ...(row.destination === "dead" ? { destination: "dead" as const } : {}) };
}

export function recoveryOperations(client: PoolClient): Pick<SchedulingTransaction, "recoverConsumption"> {
  return {
    async recoverConsumption(request) {
      const { delivery } = request;
      const key = [delivery.eventId, delivery.consumer, delivery.cycle];
      const retained = await client.query<{ destination: string; send_count: number; published_at: Date | null }>(`SELECT destination,send_count,published_at FROM scheduling.outbox_publications
        WHERE id=$1 AND event_id=$2 AND consumer=$3 AND cycle=$4 AND attempt=$5`,
      [delivery.publicationId, ...key, delivery.attempt]);
      const publication = retained.rows[0];
      if (delivery.version !== 1 || !publication || (publication.destination === "dead") !== (delivery.destination === "dead") ||
        (request.source === "application_dlq" && publication.destination !== "dead") ||
        (request.source === "broker_dlq" && publication.destination !== "work")) {
        throw new Error("Recovery does not match retained publication provenance");
      }
      if (request.source === "persisted" && publication.destination === "work" && !publication.published_at && publication.send_count === 0) {
        throw new Error("Missing-message recovery requires retained transport evidence; pending unsent work belongs to the relay");
      }
      await client.query(`INSERT INTO scheduling.consumer_results(event_id,consumer) VALUES ($1,$2) ON CONFLICT DO NOTHING`, key.slice(0, 2));
      const result = (await client.query<{ outcome: string | null; current_cycle: number }>(`SELECT outcome,current_cycle
        FROM scheduling.consumer_results WHERE event_id=$1 AND consumer=$2 FOR UPDATE`, key.slice(0, 2))).rows[0];
      const previous = (await client.query<{ outcome: RecoveryResult["outcome"]; new_cycle: number; next_publication_id: string | null }>(`SELECT outcome,new_cycle,next_publication_id
        FROM scheduling.consumer_recoveries WHERE event_id=$1 AND consumer=$2 AND source_cycle=$3 AND outcome='recovered'`, key)).rows[0];
      if (previous) return { outcome: previous.outcome, cycle: previous.new_cycle, publicationId: previous.next_publication_id };

      let outcome: RecoveryResult["outcome"] = "recovered";
      if (result.outcome) outcome = "already_completed";
      else if (result.current_cycle !== delivery.cycle) outcome = "superseded";
      const attempts = (await client.query<{ attempt: number; outcome: string | null }>(`SELECT attempt,outcome
        FROM scheduling.consumer_attempts WHERE event_id=$1 AND consumer=$2 AND cycle=$3 ORDER BY attempt DESC LIMIT 1`, key)).rows[0];
      if (outcome === "recovered" && attempts && attempts.attempt !== delivery.attempt) outcome = "superseded";
      const cycle = (await client.query<{ state: string }>(`SELECT state FROM scheduling.consumer_cycles
        WHERE event_id=$1 AND consumer=$2 AND cycle=$3`, key)).rows[0];
      if (publication.destination === "dead" && !cycle) throw new Error("Application parking has no retained cycle");
      if (outcome === "recovered" && publication.destination === "dead" && cycle?.state !== "parked") {
        throw new Error("Application recovery requires a parked cycle");
      }
      const time = (await client.query<{ at: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")).rows[0].at;
      const newCycle = outcome === "recovered" ? delivery.cycle + 1 : result.current_cycle;
      const nextId = outcome === "recovered" ? randomUUID() : null;
      if (outcome === "recovered") {
        // Preserve the old cycle, including a physical parking with no prior SQL failure.
        await client.query(`INSERT INTO scheduling.consumer_cycles(event_id,consumer,cycle,state) VALUES ($1,$2,$3,'active') ON CONFLICT DO NOTHING`, key);
        if (cycle?.state !== "parked") await client.query(`UPDATE scheduling.consumer_cycles SET state='parked',parked_at=$4,park_reason=$5
          WHERE event_id=$1 AND consumer=$2 AND cycle=$3`, [...key, time, request.source === "broker_dlq" ? "physical" : "operator"]);
        await client.query(`UPDATE scheduling.consumer_results SET current_cycle=$3 WHERE event_id=$1 AND consumer=$2`, [delivery.eventId, delivery.consumer, newCycle]);
        await client.query(`INSERT INTO scheduling.consumer_cycles(event_id,consumer,cycle,state) VALUES ($1,$2,$3,'active')`, [delivery.eventId, delivery.consumer, newCycle]);
        await client.query(`INSERT INTO scheduling.consumer_attempts(event_id,consumer,cycle,attempt,not_before) VALUES ($1,$2,$3,0,$4)`, [delivery.eventId, delivery.consumer, newCycle, time]);
        await client.query(`INSERT INTO scheduling.outbox_publications(id,event_id,consumer,cycle,attempt,available_at,created_at)
          VALUES ($1,$2,$3,$4,0,$5,$5)`, [nextId, delivery.eventId, delivery.consumer, newCycle, time]);
      }
      await client.query(`INSERT INTO scheduling.consumer_recoveries(id,event_id,consumer,source_cycle,source_attempt,source_publication_id,source,operator,reason,outcome,new_cycle,next_publication_id,recorded_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (source_publication_id) DO NOTHING`,
      [randomUUID(), ...key, delivery.attempt, delivery.publicationId, request.source, request.operator, request.reason, outcome, newCycle, nextId, time]);
      return { outcome, cycle: newCycle, publicationId: nextId };
    },
  };
}
