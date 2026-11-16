import { expect, it } from "vitest";
import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { eventually, startApiPair } from "../helpers/concurrency.ts";
import { startWorkerProcess } from "../helpers/worker-process.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const rabbitmqUrl = process.env.TEST_RABBITMQ_URL;
if (!databaseUrl || !rabbitmqUrl) throw new Error("TEST_DATABASE_URL and TEST_RABBITMQ_URL are required");

it("AC54: expires Carlos's hold through the normal sweep, offers and logs for Ana, accepts the same R2 over HTTP, then offers a cancelled appointment", async () => {
  const name = `appointment_async_e2e_${Date.now()}_${process.pid}`;
  const admin = createDatabasePool(databaseUrl);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const target = new URL(databaseUrl); target.pathname = `/${name}`;
  const pool = createDatabasePool(target.toString());
  const apis = await startApiPair(target.toString(), "async-offers-e2e", { DIRECT_HOLD_TTL_MS: "2500" });
  let w1: Awaited<ReturnType<typeof startWorkerProcess>> | undefined;
  const w2 = await startWorkerProcess(target.toString(), rabbitmqUrl, { relay: false });
  const post = async (url: string, patientId: string, key?: string, body?: object) => {
    const response = await fetch(`${apis.a.url}${url}`, { method: "POST", headers: {
      "x-patient-id": patientId, ...(key ? { "idempotency-key": key } : {}), ...(body ? { "content-type": "application/json" } : {}),
    }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const get = async (id: string, patientId: string) => (await fetch(`${apis.b.url}/waiting-list-entries/${id}`, { headers: { "x-patient-id": patientId } })).json();
  try {
    const scope = { hospitalId: "hospital-south", testTypeId: "mri" };
    const agenda = await (await fetch(`${apis.a.url}/slots?${new URLSearchParams({ ...scope, from: "2020-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" })}`)).json();
    expect(agenda.slots).toHaveLength(1);
    expect(agenda.slots[0]).toMatchObject({ id: "slot-south-mri-1", directlyBookable: true });
    const held = await post("/slots/slot-south-mri-1/holds", "patient-carlos", "ac54-carlos");
    expect(held.status).toBe(201);
    const ana = await post("/waiting-list-entries", "patient-ana", "ac54-ana", scope);
    const bruno = await post("/waiting-list-entries", "patient-bruno", "ac54-bruno", scope);
    expect([ana.status, bruno.status]).toEqual([201, 201]);
    expect(await get(ana.body.id, "patient-ana")).toMatchObject({ state: "WAITING", admissionOrder: "1" });
    expect(await get(bruno.body.id, "patient-bruno")).toMatchObject({ state: "WAITING", admissionOrder: "2" });
    const stillHeld = await (await fetch(`${apis.b.url}/reservations/${held.body.id}`, { headers: { "x-patient-id": "patient-carlos" } })).json();
    expect(stillHeld).toMatchObject({ state: "HELD", expiresAt: held.body.expiresAt, temporal: { expired: false, closurePending: false } });
    await eventually(async () => (await pool.query("SELECT state FROM scheduling.reservations WHERE id=$1", [held.body.id])).rows[0].state, (state) => state === "EXPIRED", 8000);
    expect((await pool.query("SELECT count(*)::integer AS n FROM scheduling.outbox_publications WHERE published_at IS NOT NULL")).rows[0].n).toBe(0);
    expect((await get(ana.body.id, "patient-ana")).state).toBe("WAITING");
    w1 = await startWorkerProcess(target.toString(), rabbitmqUrl, { relay: true });
    const offered = await eventually(() => get(ana.body.id, "patient-ana"), (entry) => entry.state === "OFFERED", 10000);
    const realNotice = await eventually(async () => `${w1!.logs()}\n${w2.logs()}`.split("\n").flatMap((line) => {
      try { const value = JSON.parse(line); return value.event === "offer_notification" && value.reservationId === offered.offer.id ? [value] : []; } catch { return []; }
    }), (lines) => lines.length > 0, 10000);
    expect(realNotice[0].expiresAt).toBe(offered.offer.expiresAt);
    const accepted = await post(`/reservations/${offered.offer.id}/confirm`, "patient-ana");
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ id: offered.offer.id, state: "CONFIRMED" });
    expect((await pool.query("SELECT id,state FROM scheduling.reservations WHERE slot_id='slot-south-mri-1' ORDER BY created_at,id")).rows)
      .toEqual([{ id: held.body.id, state: "EXPIRED" }, { id: offered.offer.id, state: "CONFIRMED" }]);
    expect((await get(bruno.body.id, "patient-bruno")).state).toBe("WAITING");
    process.stdout.write(`AC54 real network evidence ${JSON.stringify({ database: name, R1: held.body.id, R2: offered.offer.id, notices: realNotice, bruno: "WAITING" })}\n`);

    expect((await post(`/reservations/${offered.offer.id}/cancel`, "patient-ana")).status).toBe(200);
    const next = await eventually(() => get(bruno.body.id, "patient-bruno"), (entry) => entry.state === "OFFERED", 10000);
    await eventually(async () => `${w1!.logs()}\n${w2.logs()}`.includes(`"reservationId":"${next.offer.id}"`), Boolean, 10000);
    expect((await post(`/reservations/${next.offer.id}/confirm`, "patient-bruno")).status).toBe(200);
    expect((await get(ana.body.id, "patient-ana")).closureReason).toBe("ACCEPTED");
    expect((await get(bruno.body.id, "patient-bruno")).closureReason).toBe("ACCEPTED");
  } finally {
    await w1?.stop(); await w2.stop(); await apis.stop(); await pool.end();
  }
}, 40000);
