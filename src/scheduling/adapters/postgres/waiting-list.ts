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
  "lockWaitingListScope" | "lockAdmissionState" | "lockOwnWaitingListEntry" | "closeWaitingListEntry" | "insertWaitingListEntry" | "recordAllocationReview"> {
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
      const result = await client.query<EntryRow>(`SELECT e.*, ARRAY(SELECT x.slot_id FROM scheduling.waiting_list_slot_exclusions x WHERE x.entry_id=e.id ORDER BY x.slot_id) AS excluded_slot_ids FROM scheduling.waiting_list_entries e WHERE id=$1 AND patient_id=$2 FOR UPDATE OF e`, [entryId, patientId]);
      return result.rows[0] ? entryFromRow(result.rows[0]) : null;
    },
    async closeWaitingListEntry(entryId, reason) {
      await client.query("UPDATE scheduling.waiting_list_entries SET state='CLOSED', closure_reason=$2 WHERE id=$1", [entryId, reason]);
    },
    async lockAdmissionState(scope) {
      const key = [scope.hospitalId, scope.testTypeId];
      const slots = await client.query<{ id: string; starts_at: Date; ends_at: Date }>(`SELECT id, starts_at, ends_at
        FROM scheduling.slots WHERE hospital_id=$1 AND test_type_id=$2 ORDER BY id FOR UPDATE`, key);
      const reservations = await client.query<{ id: string; patient_id: string; slot_id: string; state: "HELD" | "OFFERED" | "CONFIRMED";
        created_at: Date; expires_at: Date; starts_at: Date; ends_at: Date }>(`SELECT r.*, s.starts_at, s.ends_at
        FROM scheduling.reservations r JOIN scheduling.slots s ON s.id=r.slot_id
        WHERE s.hospital_id=$1 AND s.test_type_id=$2 AND r.state IN ('HELD', 'OFFERED', 'CONFIRMED')
        ORDER BY r.slot_id, r.id FOR UPDATE OF r`, key);
      const entries = await client.query<EntryRow>(`SELECT e.*, ARRAY(SELECT x.slot_id FROM scheduling.waiting_list_slot_exclusions x WHERE x.entry_id=e.id ORDER BY x.slot_id) AS excluded_slot_ids
        FROM scheduling.waiting_list_entries e WHERE hospital_id=$1 AND test_type_id=$2 AND state IN ('WAITING', 'OFFERED') ORDER BY id FOR UPDATE OF e`, key);
      return { slots: slots.rows.map((row) => ({ id: row.id, startsAt: row.starts_at.getTime(), endsAt: row.ends_at.getTime() })),
        entries: entries.rows.map(entryFromRow), reservations: reservations.rows.map((row) => ({
          id: row.id, patientId: row.patient_id, slotId: row.slot_id, state: row.state,
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
    const result = await pool.query<EntryRow & { evaluated_at: Date }>(`SELECT e.*, ARRAY(SELECT x.slot_id FROM scheduling.waiting_list_slot_exclusions x WHERE x.entry_id=e.id ORDER BY x.slot_id) AS excluded_slot_ids, date_trunc('milliseconds', statement_timestamp()) AS evaluated_at
      FROM scheduling.waiting_list_entries e WHERE id=$1 AND patient_id=$2`, [entryId, patientId]);
    return result.rows[0] ? { entry: entryFromRow(result.rows[0]), evaluatedAt: result.rows[0].evaluated_at.getTime() } : null;
  } catch (error) { throw storageError(error); }
}

// Both availability reads and protected direct writes apply this predicate to the same immutable slot alias.
export const waitingListPrioritySql = `EXISTS (SELECT 1 FROM scheduling.waiting_list_entries e
  WHERE e.hospital_id=s.hospital_id AND e.test_type_id=s.test_type_id AND e.state='WAITING'
    AND NOT EXISTS (SELECT 1 FROM scheduling.waiting_list_slot_exclusions x WHERE x.entry_id=e.id AND x.slot_id=s.id))`;
