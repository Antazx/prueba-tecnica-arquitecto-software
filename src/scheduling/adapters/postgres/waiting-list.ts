import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { SchedulingTransaction } from "../../application/scheduling.ts";
import { storageError } from "./errors.ts";
import type { WaitingListEntry } from "../../application/waiting-list.ts";

interface EntryRow {
  id: string; patient_id: string; hospital_id: string; test_type_id: string; admission_order: string;
  state: WaitingListEntry["state"]; closure_reason: WaitingListEntry["closureReason"] | null; created_at: Date; excluded_slot_ids?: string[];
}
function entryFromRow(row: EntryRow): WaitingListEntry {
  return { id: row.id, patientId: row.patient_id, hospitalId: row.hospital_id, testTypeId: row.test_type_id,
    admissionOrder: row.admission_order, state: row.state, closureReason: row.closure_reason ?? undefined, createdAt: row.created_at.getTime(), excludedSlotIds: row.excluded_slot_ids ?? [] };
}

export function waitingListOperations(client: PoolClient): Pick<SchedulingTransaction,
  "lockWaitingListScope" | "lockAdmissionState" | "lockOwnWaitingListEntry" | "closeWaitingListEntry" | "returnEntryAfterRejection" | "insertWaitingListEntry" | "recordAllocationReview"> {
  return {
    async lockWaitingListScope(scope) {
      const result = await client.query(`SELECT hospital_id FROM scheduling.waiting_list_scopes
        WHERE hospital_id=$1 AND test_type_id=$2 FOR UPDATE`, [scope.hospitalId, scope.testTypeId]);
      return result.rowCount === 1;
    },
    async lockOwnWaitingListEntry(patientId, entryId) {
      if (!validUuid(entryId)) return null;
      const discovery = await client.query<EntryRow>("SELECT * FROM scheduling.waiting_list_entries WHERE id=$1 AND patient_id=$2", [entryId, patientId]);
      const target = discovery.rows[0];
      if (!target) return null;
      await client.query(`SELECT hospital_id FROM scheduling.waiting_list_scopes WHERE hospital_id=$1 AND test_type_id=$2 FOR UPDATE`, [target.hospital_id, target.test_type_id]);
      // Scope first, then slot/reservation, then entry, as with confirmation and allocation.
      await client.query(`SELECT s.id FROM scheduling.slots s JOIN scheduling.reservations r ON r.slot_id=s.id
        WHERE r.waiting_list_entry_id=$1 AND r.state='OFFERED' ORDER BY s.id FOR UPDATE OF s`, [entryId]);
      const offers = await client.query<{ id: string; slot_id: string; created_at: Date; expires_at: Date; starts_at: Date; ends_at: Date }>(`
        SELECT r.*,s.starts_at,s.ends_at FROM scheduling.reservations r JOIN scheduling.slots s ON s.id=r.slot_id
        WHERE r.waiting_list_entry_id=$1 AND r.state='OFFERED' ORDER BY r.slot_id,r.id FOR UPDATE OF r`, [entryId]);
      const result = await client.query<EntryRow>(`SELECT e.*, ARRAY(SELECT x.slot_id FROM scheduling.waiting_list_slot_exclusions x WHERE x.entry_id=e.id ORDER BY x.slot_id) AS excluded_slot_ids FROM scheduling.waiting_list_entries e WHERE id=$1 AND patient_id=$2 FOR UPDATE OF e`, [entryId, patientId]);
      if (!result.rows[0]) return null;
      const entry = entryFromRow(result.rows[0]);
      const offer = offers.rows[0];
      if (offer) entry.offer = { id: offer.id, slotId: offer.slot_id, patientId, waitingListEntryId: entry.id, state: "OFFERED",
        createdAt: offer.created_at.getTime(), expiresAt: offer.expires_at.getTime(), startsAt: offer.starts_at.getTime(), endsAt: offer.ends_at.getTime() };
      return entry;
    },
    async closeWaitingListEntry(entryId, reason) {
      await client.query("UPDATE scheduling.waiting_list_entries SET state='CLOSED', closure_reason=$2 WHERE id=$1", [entryId, reason]);
    },
    async returnEntryAfterRejection(entryId, slotId) {
      await client.query("UPDATE scheduling.waiting_list_entries SET state='WAITING' WHERE id=$1", [entryId]);
      await client.query("INSERT INTO scheduling.waiting_list_slot_exclusions(entry_id,slot_id) VALUES ($1,$2)", [entryId, slotId]);
    },
    async lockAdmissionState(scope) {
      const key = [scope.hospitalId, scope.testTypeId];
      const slots = await client.query<{ id: string; starts_at: Date; ends_at: Date }>(`SELECT id, starts_at, ends_at
        FROM scheduling.slots WHERE hospital_id=$1 AND test_type_id=$2 ORDER BY id FOR UPDATE`, key);
      const reservations = await client.query<{ id: string; patient_id: string; slot_id: string; state: "HELD" | "OFFERED" | "CONFIRMED";
        waiting_list_entry_id: string | null;
        created_at: Date; expires_at: Date; starts_at: Date; ends_at: Date }>(`SELECT r.*, s.starts_at, s.ends_at
        FROM scheduling.reservations r JOIN scheduling.slots s ON s.id=r.slot_id
        WHERE s.hospital_id=$1 AND s.test_type_id=$2 AND r.state IN ('HELD', 'OFFERED', 'CONFIRMED')
        ORDER BY r.slot_id, r.id FOR UPDATE OF r`, key);
      const entries = await client.query<EntryRow>(`SELECT e.*, ARRAY(SELECT x.slot_id FROM scheduling.waiting_list_slot_exclusions x WHERE x.entry_id=e.id ORDER BY x.slot_id) AS excluded_slot_ids
        FROM scheduling.waiting_list_entries e WHERE hospital_id=$1 AND test_type_id=$2 AND state IN ('WAITING', 'OFFERED') ORDER BY id FOR UPDATE OF e`, key);
      return { slots: slots.rows.map((row) => ({ id: row.id, startsAt: row.starts_at.getTime(), endsAt: row.ends_at.getTime() })),
        entries: entries.rows.map(entryFromRow), reservations: reservations.rows.map((row) => ({
          id: row.id, patientId: row.patient_id, slotId: row.slot_id, state: row.state,
          waitingListEntryId: row.waiting_list_entry_id ?? undefined,
          createdAt: row.created_at.getTime(), expiresAt: row.expires_at.getTime(), startsAt: row.starts_at.getTime(), endsAt: row.ends_at.getTime(),
        })) };
    },
    async insertWaitingListEntry(id, patientId, scope, createdAt) {
      // Retained history and scope coordination make MAX+1 strictly increasing, including same-millisecond admissions.
      const result = await client.query<EntryRow>(`INSERT INTO scheduling.waiting_list_entries
        (id, patient_id, hospital_id, test_type_id, admission_order, state, created_at)
        SELECT $1, $2, $3, $4, coalesce(max(admission_order), 0)+1, 'WAITING', $5
        FROM scheduling.waiting_list_entries WHERE hospital_id=$3 AND test_type_id=$4 RETURNING *`,
      [id, patientId, scope.hospitalId, scope.testTypeId, new Date(createdAt)]);
      return entryFromRow(result.rows[0]);
    },
    async recordAllocationReview(scope, entryId, occurredAt) {
      const eventId = randomUUID();
      await client.query(`INSERT INTO scheduling.events(id, type, version, occurred_at, payload)
        VALUES ($1, 'AllocationReviewRequested', 1, $2, $3)`, [eventId, new Date(occurredAt), { ...scope, entryId, reason: "ADMITTED" }]);
      await client.query(`INSERT INTO scheduling.outbox_publications(id, event_id, consumer, cycle, attempt, available_at, created_at)
        VALUES ($1, $2, 'allocation', 0, 0, $3, $3)`, [randomUUID(), eventId, new Date(occurredAt)]);
    },
  };
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
export async function readOwnWaitingListEntry(pool: Pool, patientId: string, entryId: string) {
  try {
    if (!validUuid(entryId)) return null;
    const result = await pool.query<EntryRow & { evaluated_at: Date; offer: { id: string; slot_id: string; state: "OFFERED"; created_at: string; expires_at: string; starts_at: string; ends_at: string } | null }>(`SELECT e.*, ARRAY(SELECT x.slot_id FROM scheduling.waiting_list_slot_exclusions x WHERE x.entry_id=e.id ORDER BY x.slot_id) AS excluded_slot_ids, date_trunc('milliseconds', statement_timestamp()) AS evaluated_at,
      (SELECT jsonb_build_object('id',r.id,'slot_id',r.slot_id,'state',r.state,'created_at',r.created_at,'expires_at',r.expires_at,'starts_at',s.starts_at,'ends_at',s.ends_at)
        FROM scheduling.reservations r JOIN scheduling.slots s ON s.id=r.slot_id WHERE r.waiting_list_entry_id=e.id AND r.state='OFFERED') AS offer
      FROM scheduling.waiting_list_entries e WHERE e.id=$1 AND e.patient_id=$2`, [entryId, patientId]);
    const row = result.rows[0];
    if (!row) return null;
    const entry = entryFromRow(row);
    if (row.offer) entry.offer = { id: row.offer.id, slotId: row.offer.slot_id, patientId, waitingListEntryId: entry.id, state: row.offer.state,
      createdAt: Date.parse(row.offer.created_at), expiresAt: Date.parse(row.offer.expires_at), startsAt: Date.parse(row.offer.starts_at), endsAt: Date.parse(row.offer.ends_at) };
    return { entry, evaluatedAt: row.evaluated_at.getTime() };
  } catch (error) { throw storageError(error); }
}

// Both availability reads and protected direct writes apply this predicate to the same immutable slot alias.
export const waitingListPrioritySql = `EXISTS (SELECT 1 FROM scheduling.waiting_list_entries e
  WHERE e.hospital_id=s.hospital_id AND e.test_type_id=s.test_type_id AND e.state='WAITING'
    AND NOT EXISTS (SELECT 1 FROM scheduling.waiting_list_slot_exclusions x WHERE x.entry_id=e.id AND x.slot_id=s.id))`;
