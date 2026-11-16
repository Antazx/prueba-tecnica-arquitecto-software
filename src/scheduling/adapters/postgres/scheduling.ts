import type { Pool, PoolClient } from "pg";
import type { CreationIdentity, CreationResult, Reservation, Scheduling, SchedulingTransaction } from "../../application/scheduling.ts";
import { storageError } from "./errors.ts";

interface ReservationRow {
  id: string; slot_id: string; patient_id: string; state: Reservation["state"];
  created_at: Date; expires_at: Date; starts_at: Date; ends_at: Date; evaluated_at: Date;
}

async function patientExists(client: Pool | PoolClient, patientId: string): Promise<boolean> {
  const result = await client.query("SELECT 1 FROM scheduling.patients WHERE id = $1", [patientId]);
  return result.rowCount === 1;
}

function transactionOperations(client: PoolClient): SchedulingTransaction {
  return {
    patientExists: (patientId) => patientExists(client, patientId),
    async coordinateCreation(identity: CreationIdentity) {
      const key = [identity.patientId, identity.operation, identity.key];
      // The unique key also coordinates absence; the following command sees the winner's commit.
      await client.query(`INSERT INTO scheduling.http_creation_results(patient_id, operation, idempotency_key)
        VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, key);
      const result = await client.query<{ fingerprint: string | null; status_code: 200 | 201; response_body: CreationResult["body"] }>(`
        SELECT fingerprint, status_code, response_body FROM scheduling.http_creation_results
        WHERE patient_id = $1 AND operation = $2 AND idempotency_key = $3 FOR UPDATE`, key);
      const row = result.rows[0];
      return row.fingerprint === null ? null : { fingerprint: row.fingerprint, status: row.status_code, body: row.response_body };
    },
    async lockSlotForHold(slotId) {
      // Agenda is immutable. This discovery query acquires no business lock.
      const scope = await client.query<{ hospital_id: string; test_type_id: string }>(
        "SELECT hospital_id, test_type_id FROM scheduling.slots WHERE id = $1", [slotId]);
      if (!scope.rows[0]) return null;
      await client.query(`SELECT hospital_id FROM scheduling.waiting_list_scopes
        WHERE hospital_id = $1 AND test_type_id = $2 FOR UPDATE`, [scope.rows[0].hospital_id, scope.rows[0].test_type_id]);
      // READ COMMITTED, new commands after the wait: do not reuse pre-lock snapshots.
      const slots = await client.query<{ id: string; starts_at: Date; ends_at: Date }>(
        "SELECT id, starts_at, ends_at FROM scheduling.slots WHERE id = $1 FOR UPDATE", [slotId]);
      const occupants = await client.query(`SELECT id FROM scheduling.reservations
        WHERE slot_id = $1 AND state IN ('HELD', 'OFFERED', 'CONFIRMED') ORDER BY id FOR UPDATE`, [slotId]);
      const slot = slots.rows[0];
      return { id: slot.id, startsAt: slot.starts_at.getTime(), endsAt: slot.ends_at.getTime(), occupied: occupants.rowCount !== 0 };
    },
    async currentTime() {
      // A separate command is essential: no clock evaluation before a lock wait.
      const result = await client.query<{ at: Date }>("SELECT date_trunc('milliseconds', clock_timestamp()) AS at");
      return result.rows[0].at.getTime();
    },
    async insertDirectHold(reservation) {
      await client.query(`INSERT INTO scheduling.reservations(id, slot_id, patient_id, state, created_at, expires_at)
        VALUES ($1, $2, $3, 'HELD', $4, $5)`, [reservation.id, reservation.slotId, reservation.patientId,
        new Date(reservation.createdAt), new Date(reservation.expiresAt)]);
    },
    async saveCreationResult(identity, result) {
      await client.query(`UPDATE scheduling.http_creation_results SET fingerprint = $4, status_code = $5, response_body = $6
        WHERE patient_id = $1 AND operation = $2 AND idempotency_key = $3`,
      [identity.patientId, identity.operation, identity.key, result.fingerprint, result.status, result.body]);
    },
  };
}

export function postgresScheduling(pool: Pool): Scheduling {
  return {
    async transaction(work) {
      let client: PoolClient | undefined;
      let discard = false;
      try {
        client = await pool.connect();
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query("SET LOCAL lock_timeout = '2s'");
        await client.query("SET LOCAL statement_timeout = '2500ms'");
        const result = await work(transactionOperations(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        if (client) {
          try { await client.query("ROLLBACK"); } catch { discard = true; }
        }
        throw storageError(error);
      } finally {
        client?.release(discard);
      }
    },
    async patientExists(patientId) {
      try { return await patientExists(pool, patientId); } catch (error) { throw storageError(error); }
    },
    async readOwnReservation(patientId, reservationId) {
      try {
        // UUID syntax is checked before querying; an arbitrary missing public ID is still 404.
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reservationId)) return null;
        const result = await pool.query<ReservationRow>(`SELECT r.*, s.starts_at, s.ends_at,
          date_trunc('milliseconds', statement_timestamp()) AS evaluated_at
          FROM scheduling.reservations r JOIN scheduling.slots s ON s.id = r.slot_id
          WHERE r.id = $1 AND r.patient_id = $2`, [reservationId, patientId]);
        const row = result.rows[0];
        if (!row) return null;
        return { evaluatedAt: row.evaluated_at.getTime(), reservation: {
          id: row.id, slotId: row.slot_id, patientId: row.patient_id, state: row.state,
          createdAt: row.created_at.getTime(), expiresAt: row.expires_at.getTime(),
          startsAt: row.starts_at.getTime(), endsAt: row.ends_at.getTime(),
        } };
      } catch (error) { throw storageError(error); }
    },
  };
}
