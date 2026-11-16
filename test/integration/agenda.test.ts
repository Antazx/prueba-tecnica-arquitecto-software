import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { initializeDatabase } from "../../src/scheduling/adapters/postgres/initialize.ts";
import { buildApi } from "../../src/scheduling/adapters/http/api.ts";
import { listSlots } from "../../src/scheduling/adapters/postgres/slots.ts";
import type { AgendaSnapshot } from "../../src/scheduling/application/agenda.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required; use an isolated test database");
const pool = createDatabasePool(databaseUrl);
const readOnlyUrl = new URL(databaseUrl);
readOnlyUrl.searchParams.set("options", "-c default_transaction_read_only=on");
const reader = createDatabasePool(readOnlyUrl.toString());
const api = buildApi(() => Promise.resolve(), (query) => listSlots(reader, query));
const baseQuery = { hospitalId: "hospital-north", testTypeId: "mri", from: "2020-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" };
const getSlots = (query = baseQuery) => api.inject({ url: `/slots?${new URLSearchParams(query)}` });

beforeAll(async () => { await initializeDatabase(pool); });
afterAll(async () => { await api.close(); await reader.end(); await pool.end(); });

describe("seeded agenda over HTTP and PostgreSQL", () => {
  it("returns future slots of the requested scope without patient data", async () => {
    const response = await getSlots();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      slots: [
        { id: "slot-north-mri-1", resourceId: "scanner-north-1", directlyBookable: true },
        { id: "slot-north-mri-3", resourceId: "scanner-north-2", directlyBookable: true },
        { id: "slot-north-mri-2", resourceId: "scanner-north-1", directlyBookable: true },
      ],
    });
    const body = response.json<AgendaSnapshot>();
    expect(body.evaluatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(Object.keys(body.slots[0]).sort()).toEqual([
      "directlyBookable", "endsAt", "hospitalId", "id", "resourceId", "startsAt", "testTypeId",
    ]);
    expect(body.slots.every((slot) => slot.startsAt > body.evaluatedAt)).toBe(true);
  });

  it("preserves slot identities and dates without duplicates when initialization repeats", async () => {
    const before = (await getSlots()).json<AgendaSnapshot>();
    await initializeDatabase(pool);
    const after = (await getSlots()).json<AgendaSnapshot>();
    expect(after.slots).toEqual(before.slots);
  });

  it("includes the lower start boundary, excludes the upper boundary and normalizes offsets", async () => {
    const slots = (await getSlots()).json<AgendaSnapshot>().slots;
    const lowerWithOffset = slots[0].startsAt.replace("09:00:00.000Z", "11:00:00.000+02:00");
    const response = await getSlots({ ...baseQuery, from: lowerWithOffset, to: slots[2].startsAt });
    expect(response.json<AgendaSnapshot>().slots.map((slot) => slot.id))
      .toEqual(["slot-north-mri-1", "slot-north-mri-3"]);
  });

  it.each([
    { hospitalId: "hospital-south", testTypeId: "mri", ids: ["slot-south-mri-1"] },
    { hospitalId: "hospital-north", testTypeId: "ultrasound", ids: ["slot-north-ultrasound-1"] },
    { hospitalId: "missing", testTypeId: "mri", ids: [] },
  ])("keeps the hospital and test type filters: $hospitalId/$testTypeId", async ({ hospitalId, testTypeId, ids }) => {
    const response = await getSlots({ ...baseQuery, hospitalId, testTypeId });
    expect(response.statusCode).toBe(200);
    expect(response.json<AgendaSnapshot>().slots.map((slot) => slot.id)).toEqual(ids);
  });

  it.each([
    "hospitalId=hospital-north&testTypeId=mri",
    new URLSearchParams({ ...baseQuery, hospitalId: "" }).toString(),
    new URLSearchParams({ ...baseQuery, from: baseQuery.to }).toString(),
    new URLSearchParams({ ...baseQuery, from: "2101-01-01T00:00:00Z" }).toString(),
    new URLSearchParams({ ...baseQuery, from: "2030-01-01T00:00:00" }).toString(),
    new URLSearchParams({ ...baseQuery, from: "2030-01-01T00:00:00.1234Z" }).toString(),
    new URLSearchParams({ ...baseQuery, to: "2030-02-30T00:00:00Z" }).toString(),
    new URLSearchParams({ ...baseQuery, extra: "unexpected" }).toString(),
    `${new URLSearchParams(baseQuery)}&from=2030-01-01T00:00:00Z`,
  ])("rejects an invalid agenda query: %s", async (query) => {
    expect((await api.inject({ url: `/slots?${query}` })).statusCode).toBe(400);
  });

  it("excludes slots that have already started without removing their persisted agenda", async () => {
    await pool.query(`INSERT INTO scheduling.slots
      VALUES ('started-slot', 'scanner-north-1', 'hospital-north', 'mri',
              date_trunc('day', now()) - interval '1 day',
              date_trunc('day', now()) - interval '1 day' + interval '30 minutes')`);
    try {
      expect((await getSlots()).json<AgendaSnapshot>().slots.map((slot) => slot.id))
        .toEqual(["slot-north-mri-1", "slot-north-mri-3", "slot-north-mri-2"]);
    } finally {
      await pool.query("DELETE FROM scheduling.slots WHERE id = 'started-slot'");
    }
  });

  it("refuses startup with an overlapping resource agenda in PostgreSQL", async () => {
    await pool.query(`INSERT INTO scheduling.slots
      SELECT 'overlapping-slot', resource_id, hospital_id, test_type_id, starts_at, ends_at
      FROM scheduling.slots WHERE id = 'slot-north-mri-1'`);
    try {
      await expect(initializeDatabase(pool)).rejects.toThrow("overlap");
    } finally {
      await pool.query("DELETE FROM scheduling.slots WHERE id = 'overlapping-slot'");
    }
  });

  it("rejects an empty slot and a resource from another scope at the database boundary", async () => {
    await expect(pool.query(`INSERT INTO scheduling.slots
      SELECT 'empty-slot', resource_id, hospital_id, test_type_id, starts_at, starts_at
      FROM scheduling.slots WHERE id = 'slot-north-mri-1'`)).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`INSERT INTO scheduling.slots
      SELECT 'wrong-scope-slot', resource_id, 'hospital-south', test_type_id, starts_at, ends_at
      FROM scheduling.slots WHERE id = 'slot-north-mri-1'`)).rejects.toMatchObject({ code: "23503" });
  });
});
