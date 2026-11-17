import { randomUUID } from "node:crypto";
import { connect } from "amqplib";
import { expect, it } from "vitest";
import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { initializeDatabase } from "../../src/scheduling/adapters/postgres/initialize.ts";
import { eventually } from "../helpers/concurrency.ts";
import { startWorkerProcess } from "../helpers/worker-process.ts";

it.each([{ failedCount: 1, sqlstate: "P0001" }, { failedCount: 100, sqlstate: "55P03" }])(
  "keeps expiry and publication progressing past $failedCount persistent commit failures ($sqlstate)",
  async ({ failedCount, sqlstate }) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    const rabbitmqUrl = process.env.TEST_RABBITMQ_URL;
    if (!databaseUrl || !rabbitmqUrl) throw new Error("TEST_DATABASE_URL and TEST_RABBITMQ_URL are required");
    const name = `expiry_isolation_${randomUUID().replaceAll("-", "")}`;
    const admin = createDatabasePool(databaseUrl);
    try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
    const target = new URL(databaseUrl); target.pathname = `/${name}`;
    const pool = createDatabasePool(target.toString());
    let worker: Awaited<ReturnType<typeof startWorkerProcess>> | undefined;
    const healthyId = "20000000-0000-0000-0000-000000000001";
    const failedIds = Array.from({ length: failedCount }, (_, i) => `10000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`);
    const independentEvent = randomUUID();
    const entryId = randomUUID();
    try {
      await initializeDatabase(pool);
      worker = await startWorkerProcess(target.toString(), rabbitmqUrl, { expirySweepIntervalMs: 50 });
      // Fail at COMMIT, after the reservation, closure, event, outbox and entry writes.
      await pool.query(`CREATE FUNCTION scheduling.fail_expiry_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.reservation_id::text LIKE '10000000-%' THEN
          RAISE EXCEPTION 'Injected expiry failure' USING ERRCODE = '${sqlstate}';
        END IF; RETURN NEW; END $$`);
      await pool.query(`CREATE CONSTRAINT TRIGGER fail_expiry_commit AFTER INSERT ON scheduling.reservation_closures
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION scheduling.fail_expiry_commit()`);
      const fixture = await pool.connect();
      try {
        await fixture.query("BEGIN");
        const expiry = (await fixture.query("SELECT date_trunc('milliseconds', clock_timestamp()) - interval '1 minute' AS at")).rows[0].at;
        for (const [index, id] of [...failedIds, healthyId].entries()) {
          const healthy = id === healthyId;
          await fixture.query(`INSERT INTO scheduling.slots VALUES ($1,$2,$3,'mri',
            $4::timestamptz + interval '3 days' + $5 * interval '1 hour',
            $4::timestamptz + interval '3 days 30 minutes' + $5 * interval '1 hour')`,
          [id, healthy ? "scanner-south-1" : "scanner-north-1", healthy ? "hospital-south" : "hospital-north", expiry, index]);
          await fixture.query(`INSERT INTO scheduling.reservations(id,slot_id,patient_id,state,created_at,expires_at)
            VALUES ($1::text::uuid,$1::text,'patient-ana','HELD',$2::timestamptz-interval '1 minute',$2)`, [id, expiry]);
        }
        if (failedCount === 1) {
          await fixture.query(`INSERT INTO scheduling.waiting_list_entries
            (id,patient_id,hospital_id,test_type_id,admission_order,state,created_at)
            VALUES ($1,'patient-ana','hospital-north','mri',1,'OFFERED',$2)`, [entryId, expiry]);
          await fixture.query("UPDATE scheduling.reservations SET state='OFFERED',waiting_list_entry_id=$2 WHERE id=$1", [failedIds[0], entryId]);
        }
        await fixture.query(`INSERT INTO scheduling.events VALUES ($1,'AllocationReviewRequested',1,$2,
          '{"hospitalId":"hospital-south","testTypeId":"mri"}')`, [independentEvent, expiry]);
        await fixture.query(`INSERT INTO scheduling.outbox_publications(id,event_id,consumer,cycle,attempt,available_at,created_at)
          VALUES ($1,$2,'allocation',0,0,$3,$3)`, [randomUUID(), independentEvent, expiry]);
        await fixture.query("COMMIT");
      } finally { await fixture.query("ROLLBACK"); fixture.release(); }

      await eventually(async () => (await pool.query(`SELECT
        (SELECT state FROM scheduling.reservations WHERE id=$1) AS state,
        (SELECT published_at IS NOT NULL FROM scheduling.outbox_publications WHERE event_id=$2) AS published`,
      [healthyId, independentEvent])).rows[0], (row) => row.state === "EXPIRED" && row.published, 5000);
      await eventually(async () => (await pool.query(`SELECT count(*)::integer AS n
        FROM scheduling.reservation_closures c JOIN scheduling.outbox_publications p ON p.event_id=c.event_id
        JOIN scheduling.consumer_results r ON r.event_id=c.event_id AND r.consumer='allocation'
        WHERE c.reservation_id=$1 AND p.published_at IS NOT NULL AND r.outcome='succeeded'`, [healthyId])).rows[0].n,
      (count) => count === 1, 3000);
      // The first candidate is retried on a later pass while its fault remains active.
      await eventually(async () => worker!.logs().split(failedIds[0]).length - 1, (count) => count >= 2, 5000);
      expect((await pool.query("SELECT state FROM scheduling.reservations WHERE id=ANY($1::uuid[])", [failedIds])).rows)
        .toEqual(failedIds.map(() => ({ state: failedCount === 1 ? "OFFERED" : "HELD" })));
      expect((await pool.query("SELECT * FROM scheduling.reservation_closures WHERE reservation_id=ANY($1::uuid[])", [failedIds])).rows).toEqual([]);
      expect((await pool.query("SELECT * FROM scheduling.events WHERE payload->>'reservationId'=ANY($1::text[])", [failedIds])).rows).toEqual([]);
      if (failedCount === 1) {
        expect((await pool.query("SELECT state,closure_reason FROM scheduling.waiting_list_entries WHERE id=$1", [entryId])).rows[0])
          .toEqual({ state: "OFFERED", closure_reason: null });
      }
      expect(worker.logs()).not.toContain('"event":"worker_not_ready"');

      await pool.query("DROP TRIGGER fail_expiry_commit ON scheduling.reservation_closures");
      await eventually(async () => (await pool.query("SELECT count(*)::integer AS n FROM scheduling.reservations WHERE state='EXPIRED'")).rows[0].n,
        (count) => count === failedCount + 1, 5000);
      expect((await pool.query("SELECT count(*)::integer AS n FROM scheduling.reservation_closures")).rows[0].n).toBe(failedCount + 1);
      expect((await pool.query("SELECT count(*)::integer AS n FROM scheduling.events WHERE type='SlotReleased'")).rows[0].n).toBe(failedCount + 1);
      expect((await pool.query(`SELECT p.send_count FROM scheduling.outbox_publications p
        JOIN scheduling.reservation_closures c ON c.event_id=p.event_id WHERE c.reservation_id=$1`, [healthyId])).rows[0].send_count).toBe(1);
      await eventually(async () => (await pool.query("SELECT count(*)::integer AS n FROM scheduling.consumer_results WHERE outcome='succeeded'")).rows[0].n,
        (count) => count === failedCount + 2, 5000);
    } catch (error) { throw new Error(`Worker logs: ${worker?.logs()}`, { cause: error }); }
    finally {
      await worker?.stop();
      // Remove only this fixture's deliveries, including any requeued during shutdown.
      const connection = await connect(rabbitmqUrl);
      try {
        const ids = new Set((await pool.query<{ id: string }>("SELECT id FROM scheduling.outbox_publications")).rows.map((row) => row.id));
        const channel = await connection.createChannel();
        for (const queue of ["appointments.allocation", "appointments.allocation.dlq"]) {
          const retained = [];
          let message;
          while ((message = await channel.get(queue, { noAck: false }))) {
            if (ids.has(String(message.properties.messageId))) channel.ack(message);
            else retained.push(message);
          }
          for (const other of retained) channel.reject(other, true);
        }
        await channel.close();
      } finally { await connection.close(); await pool.end(); }
    }
  }, 20000,
);
