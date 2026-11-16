import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { SchedulingTransaction } from "../../application/scheduling.ts";
import { ConsumptionDeferred, type LogicalEvent } from "../../application/messages.ts";

export function messageOperations(client: PoolClient): Pick<SchedulingTransaction,
  "coordinateConsumption" | "completeConsumption" | "failConsumption" | "readOfferNotification" | "insertOffer"> {
  return {
    async coordinateConsumption(delivery) {
      const key = [delivery.eventId, delivery.consumer, delivery.cycle, delivery.attempt];
      const stored = await client.query<LogicalEvent & { available_at: Date }>(`SELECT e.type, e.version, e.payload, p.available_at
        FROM scheduling.outbox_publications p JOIN scheduling.events e ON e.id=p.event_id
        WHERE p.id=$5 AND p.event_id=$1 AND p.consumer=$2 AND p.cycle=$3 AND p.attempt=$4 AND p.destination='work'`, [...key, delivery.publicationId]);
      const event = stored.rows[0];
      if (delivery.version !== 1 || !event) throw new Error("Delivery does not match retained publication");
      await client.query(`INSERT INTO scheduling.consumer_results(event_id, consumer) VALUES ($1,$2) ON CONFLICT DO NOTHING`, key.slice(0, 2));
      const result = await client.query<{ outcome: string | null; current_cycle: number }>(`SELECT outcome, current_cycle
        FROM scheduling.consumer_results WHERE event_id=$1 AND consumer=$2 FOR UPDATE`, key.slice(0, 2));
      if (result.rows[0].outcome || result.rows[0].current_cycle !== delivery.cycle) return null;
      await client.query(`INSERT INTO scheduling.consumer_cycles(event_id, consumer, cycle, state) VALUES ($1,$2,$3,'active')
        ON CONFLICT DO NOTHING`, key.slice(0, 3));
      const cycle = await client.query<{ state: string }>(`SELECT state FROM scheduling.consumer_cycles
        WHERE event_id=$1 AND consumer=$2 AND cycle=$3`, key.slice(0, 3));
      if (cycle.rows[0].state !== "active") return null;
      await client.query(`INSERT INTO scheduling.consumer_attempts(event_id, consumer, cycle, attempt, not_before)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [...key, event.available_at]);
      const attempt = await client.query<{ outcome: string | null; ready: boolean }>(`SELECT outcome,
        not_before <= clock_timestamp() AS ready FROM scheduling.consumer_attempts WHERE event_id=$1 AND consumer=$2 AND cycle=$3 AND attempt=$4`, key);
      if (attempt.rows[0].outcome) return null;
      if (!attempt.rows[0].ready) throw new ConsumptionDeferred("Delivery arrived before its durable execution date");
      return { type: event.type, version: event.version, payload: event.payload };
    },
    async completeConsumption(delivery, outcome, time) {
      const key = [delivery.eventId, delivery.consumer, delivery.cycle, delivery.attempt, outcome, new Date(time)];
      await client.query(`UPDATE scheduling.consumer_attempts SET outcome=$5, completed_at=$6
        WHERE event_id=$1 AND consumer=$2 AND cycle=$3 AND attempt=$4`, key);
      await client.query(`UPDATE scheduling.consumer_cycles SET state='completed' WHERE event_id=$1 AND consumer=$2 AND cycle=$3`, key.slice(0, 3));
      await client.query(`UPDATE scheduling.consumer_results SET outcome=$3, completed_at=$4
        WHERE event_id=$1 AND consumer=$2`, [delivery.eventId, delivery.consumer, outcome, new Date(time)]);
    },
    async failConsumption(delivery, error, permanent, plan, time) {
      const key = [delivery.eventId, delivery.consumer, delivery.cycle, delivery.attempt];
      await client.query(`UPDATE scheduling.consumer_attempts SET outcome='failed', completed_at=$5,last_error=$6,failure_kind=$7
        WHERE event_id=$1 AND consumer=$2 AND cycle=$3 AND attempt=$4`, [...key, new Date(time), error, permanent ? "permanent" : "transient"]);
      if (plan.kind === "retry") {
        await client.query(`INSERT INTO scheduling.consumer_attempts(event_id,consumer,cycle,attempt,not_before)
          VALUES ($1,$2,$3,$4,$5)`, [delivery.eventId, delivery.consumer, delivery.cycle, plan.attempt, new Date(plan.notBefore)]);
        await client.query(`INSERT INTO scheduling.outbox_publications(id,event_id,consumer,cycle,attempt,available_at,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), delivery.eventId, delivery.consumer, delivery.cycle, plan.attempt, new Date(plan.notBefore), new Date(time)]);
      } else {
        await client.query(`UPDATE scheduling.consumer_cycles SET state='parked',parked_at=$4,park_reason=$5
          WHERE event_id=$1 AND consumer=$2 AND cycle=$3`, [delivery.eventId, delivery.consumer, delivery.cycle, new Date(time), plan.reason]);
        await client.query(`INSERT INTO scheduling.outbox_publications(id,event_id,consumer,cycle,attempt,available_at,created_at,destination)
          VALUES ($1,$2,$3,$4,$5,$6,$6,'dead')`, [randomUUID(), ...key, new Date(time)]);
      }
    },
    async readOfferNotification(reservationId, eventId) {
      // A fresh command immediately before output; never lock the business scope here.
      const result = await client.query<{ id: string; slot_id: string; patient_id: string; expires_at: Date }>(`SELECT id, slot_id, patient_id, expires_at
        FROM scheduling.reservations WHERE id=$1 AND state='OFFERED'
        AND expires_at > date_trunc('milliseconds', clock_timestamp())`, [reservationId]);
      const row = result.rows[0];
      return row ? { event: "offer_notification", eventId, reservationId: row.id, slotId: row.slot_id,
        patientId: row.patient_id, expiresAt: row.expires_at.toISOString() } : null;
    },
    async insertOffer(reservation, scope) {
      await client.query(`INSERT INTO scheduling.reservations(id,slot_id,patient_id,waiting_list_entry_id,state,created_at,expires_at)
        VALUES ($1,$2,$3,$4,'OFFERED',$5,$6)`, [reservation.id, reservation.slotId, reservation.patientId,
        reservation.waitingListEntryId, new Date(reservation.createdAt), new Date(reservation.expiresAt)]);
      await client.query("UPDATE scheduling.waiting_list_entries SET state='OFFERED' WHERE id=$1", [reservation.waitingListEntryId]);
      const eventId = randomUUID();
      await client.query(`INSERT INTO scheduling.events(id,type,version,occurred_at,payload) VALUES ($1,'OfferCreated',1,$2,$3)`,
        [eventId, new Date(reservation.createdAt), { ...scope, reservationId: reservation.id, slotId: reservation.slotId, entryId: reservation.waitingListEntryId }]);
      await client.query(`INSERT INTO scheduling.outbox_publications(id,event_id,consumer,cycle,attempt,available_at,created_at)
        VALUES ($1,$2,'notification',0,0,$3,$3)`, [randomUUID(), eventId, new Date(reservation.createdAt)]);
    },
  };
}
