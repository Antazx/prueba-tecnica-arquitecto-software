import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { eventually, freePort, startApiPair } from "../helpers/concurrency.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const rabbitmqUrl = process.env.TEST_RABBITMQ_URL;
if (!databaseUrl || !rabbitmqUrl) throw new Error("TEST_DATABASE_URL and TEST_RABBITMQ_URL are required");

async function startWorker(database: string) {
  const port = await freePort();
  const child = spawn(process.execPath, ["src/bootstrap/worker.ts"], { cwd: process.cwd(), env: {
    ...process.env, DATABASE_URL: database, RABBITMQ_URL: rabbitmqUrl, HOST: "127.0.0.1", WORKER_HEALTH_PORT: String(port),
    RELAY_ENABLED: "true", EXPIRY_SWEEP_INTERVAL_MS: "30", OFFER_MAXIMUM_MS: "2200",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout?.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
  const stop = async () => {
    if (child.exitCode !== null) return;
    const exited = once(child, "exit"); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  try {
    await eventually(async () => {
      if (child.exitCode !== null) throw new Error(logs);
      try { return (await fetch(`http://127.0.0.1:${port}/health/ready`)).ok; } catch { return false; }
    }, Boolean, 10000);
    return { stop, logs: () => logs };
  } catch (error) { await stop(); throw error; }
}

it.each([false, true])("AC69: expires an offer whose notification remains pending, omits the old notice and only offers a future slot; started=%s", async (started) => {
  const name = `offer_notice_e2e_${Date.now()}_${process.pid}`;
  const admin = createDatabasePool(databaseUrl);
  try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
  const target = new URL(databaseUrl); target.pathname = `/${name}`;
  const pool = createDatabasePool(target.toString());
  const apis = await startApiPair(target.toString(), `offer-notice-${started}`);
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  const scope = { hospitalId: "hospital-south", testTypeId: "mri" };
  const post = async (path: string, patientId: string, key?: string, body?: object) => {
    const response = await fetch(`${apis.a.url}${path}`, { method: "POST", headers: {
      "x-patient-id": patientId, ...(key ? { "idempotency-key": key } : {}), ...(body ? { "content-type": "application/json" } : {}),
    }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const get = async (id: string, patient: string) => (await fetch(`${apis.b.url}/waiting-list-entries/${id}`, { headers: { "x-patient-id": patient } })).json();
  try {
    // Delay only Ana's transport work. Offers, expiry and subsequent allocations use normal production paths.
    await pool.query(`CREATE FUNCTION scheduling.delay_ana_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.consumer='notification' THEN
        SELECT r.expires_at+interval '750 milliseconds' INTO NEW.available_at FROM scheduling.events e
        JOIN scheduling.reservations r ON r.id=(e.payload->>'reservationId')::uuid
        WHERE e.id=NEW.event_id AND r.patient_id='patient-ana';
        IF NEW.available_at IS NULL THEN NEW.available_at=NEW.created_at; END IF;
      END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER delay_ana_notice BEFORE INSERT ON scheduling.outbox_publications
      FOR EACH ROW EXECUTE FUNCTION scheduling.delay_ana_notice()`);
    const held = await post("/slots/slot-south-mri-1/holds", "patient-carlos", "notice-carlos");
    expect(held.status).toBe(201);
    const ana = await post("/waiting-list-entries", "patient-ana", "notice-ana", scope);
    const bruno = await post("/waiting-list-entries", "patient-bruno", "notice-bruno", scope);
    expect([ana.status, bruno.status]).toEqual([201, 201]);
    if (started) await pool.query(`UPDATE scheduling.slots SET starts_at=date_trunc('milliseconds',clock_timestamp())+interval '1800 milliseconds',
      ends_at=date_trunc('milliseconds',clock_timestamp())+interval '30 minutes' WHERE id='slot-south-mri-1'`);
    expect((await post(`/reservations/${held.body.id}/cancel`, "patient-carlos")).status).toBe(200);
    worker = await startWorker(target.toString());
    const offered = await eventually(() => get(ana.body.id, "patient-ana"), (entry) => entry.state === "OFFERED", 8000);
    const notice = (await pool.query(`SELECT p.id,p.event_id,p.published_at,p.available_at FROM scheduling.outbox_publications p JOIN scheduling.events e ON e.id=p.event_id
      WHERE e.type='OfferCreated' AND e.payload->>'reservationId'=$1`, [offered.offer.id])).rows[0];
    expect(notice.published_at).toBeNull();
    expect(notice.available_at.getTime()).toBeGreaterThan(Date.parse(offered.offer.expiresAt));
    expect(worker.logs().includes(`"reservationId":"${offered.offer.id}"`)).toBe(false);
    await eventually(() => get(ana.body.id, "patient-ana"), (entry) => entry.state === "CLOSED" && entry.closureReason === "EXPIRED", 8000);
    expect((await post(`/reservations/${offered.offer.id}/confirm`, "patient-ana"))).toMatchObject({ status: 409, body: { id: offered.offer.id, state: "EXPIRED" } });
    await eventually(async () => (await pool.query("SELECT outcome FROM scheduling.consumer_results WHERE event_id=$1 AND consumer='notification'", [notice.event_id])).rows[0]?.outcome,
      (outcome) => outcome === "discarded", 8000);
    expect(worker.logs().includes(`"reservationId":"${offered.offer.id}"`)).toBe(false);
    if (started) {
      const release = (await pool.query("SELECT event_id FROM scheduling.reservation_closures WHERE reservation_id=$1", [offered.offer.id])).rows[0];
      await eventually(async () => (await pool.query("SELECT outcome FROM scheduling.consumer_results WHERE event_id=$1 AND consumer='allocation'", [release.event_id])).rows[0]?.outcome,
        (outcome) => outcome === "succeeded", 8000);
      expect(await get(bruno.body.id, "patient-bruno")).toMatchObject({ state: "WAITING" });
      expect((await pool.query("SELECT count(*)::integer AS n FROM scheduling.reservations WHERE slot_id='slot-south-mri-1' AND state='OFFERED'")).rows[0].n).toBe(0);
    } else {
      const next = await eventually(() => get(bruno.body.id, "patient-bruno"), (entry) => entry.state === "OFFERED", 8000);
      await eventually(async () => worker!.logs().includes(`"reservationId":"${next.offer.id}"`), Boolean, 8000);
      expect((await post(`/reservations/${next.offer.id}/confirm`, "patient-bruno"))).toMatchObject({ status: 200, body: { id: next.offer.id, state: "CONFIRMED" } });
    }
    process.stdout.write(`AC69 real network evidence ${JSON.stringify({ database: name, started, expiredReservation: offered.offer.id, noticeEvent: notice.event_id, outcome: "discarded" })}\n`);
  } catch (error) { throw new Error(`Worker logs: ${worker?.logs()}`, { cause: error }); }
  finally { await worker?.stop(); await apis.stop(); await pool.end(); }
}, 25000);
