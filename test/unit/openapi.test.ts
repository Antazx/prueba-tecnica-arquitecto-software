import { afterEach, expect, it, vi } from "vitest";
import { readApiContract, expectContractResponse, captureApiRoutes, expectContractCoverage, validateApiDocument } from "../helpers/openapi.ts";
import { schedulingUseCases } from "../../src/scheduling/application/reservations.ts";
import { postgresScheduling } from "../../src/scheduling/adapters/postgres/scheduling.ts";
import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { DependencyUnavailable } from "../../src/scheduling/application/scheduling.ts";
import { buildApi } from "../../src/scheduling/adapters/http/api.ts";

const apis: ReturnType<typeof buildApi>[] = [];
afterEach(async () => { await Promise.all(apis.splice(0).map((api) => api.close())); });

function api() {
  const app = buildApi(async () => {}, async () => ({ evaluatedAt: "2030-01-01T00:00:00.000Z", slots: [] }));
  apis.push(app);
  return app;
}

function schedulingApi() {
  const app = buildApi(async () => {}, async () => ({ evaluatedAt: "2030-01-01T00:00:00.000Z", slots: [] }), schedulingUseCases(postgresScheduling(createDatabasePool("postgresql://synthetic:synthetic@127.0.0.1:1/synthetic"))));
  apis.push(app);
  return app;
}

it("publishes offer rejection with reservation-shaped expiry and state conflicts", async () => {
  const document = await readApiContract(schedulingApi());
  const operation = document.paths["/reservations/{id}/reject"]?.post;
  expect(operation).toBeDefined();
  expect(operation).not.toHaveProperty("requestBody");
  expect(operation.parameters?.map(({ name, in: location }) => `${location}:${name}`).sort()).toEqual(["header:x-patient-id", "path:id"]);
  expect(Object.keys(operation.responses).sort()).toEqual(["200", "400", "404", "409", "500", "503"]);
  expect(operation.responses["200"].content!["application/json"].schema).toMatchObject({ properties: { state: { enum: ["CANCELLED"] } } });
  expect(operation.responses["409"].content!["application/json"].schema).toMatchObject({
    oneOf: ["EXPIRED", "HELD", "CONFIRMED", "CANCELLED"].map((state) => ({
      additionalProperties: false, required: expect.arrayContaining(["id", "slotId", "state", "createdAt", "expiresAt", "startsAt", "endsAt", "code"]),
      properties: { state: { enum: [state] }, code: { enum: [state === "EXPIRED" ? "RESERVATION_EXPIRED" : "RESERVATION_STATE_CONFLICT"] } },
    })),
  });
});

it("publishes withdrawal without a body or key and preserves all terminal causes", async () => {
  const document = await readApiContract(schedulingApi());
  const operation = document.paths["/waiting-list-entries/{id}/withdraw"]?.post;
  expect(operation).toBeDefined();
  expect(operation).not.toHaveProperty("requestBody");
  expect(operation.parameters?.map(({ name, in: location }) => `${location}:${name}`).sort()).toEqual(["header:x-patient-id", "path:id"]);
  expect(Object.keys(operation.responses).sort()).toEqual(["200", "400", "404", "500", "503"]);
  expect(operation.responses["200"].content!["application/json"].schema).toMatchObject({
    required: expect.arrayContaining(["id", "hospitalId", "testTypeId", "admissionOrder", "state", "createdAt", "excludedSlotIds", "closureReason"]),
    additionalProperties: false, properties: { state: { enum: ["CLOSED"] }, closureReason: { enum: ["ACCEPTED", "EXPIRED", "WITHDRAWN"] } },
  });
  expect(operation.responses["200"].content!["application/json"].schema).not.toHaveProperty("properties.offer");
});

it("publishes waiting entry reads with optional offer, closure cause and temporal actions", async () => {
  const document = await readApiContract(schedulingApi());
  const operation = document.paths["/waiting-list-entries/{id}"]?.get;
  expect(operation).toBeDefined();
  expect(operation).not.toHaveProperty("requestBody");
  expect(Object.keys(operation.responses).sort()).toEqual(["200", "400", "404", "500", "503"]);
  expect(operation.parameters?.map(({ name, in: location }) => `${location}:${name}`).sort()).toEqual(["header:x-patient-id", "path:id"]);
  expect(operation.responses["200"].content!["application/json"].schema).toMatchObject({
    oneOf: [
      { required: expect.arrayContaining(["id", "admissionOrder", "evaluatedAt", "temporal", "actions"]), additionalProperties: false, properties: { state: { enum: ["WAITING"] } } },
      { required: expect.arrayContaining(["offer", "evaluatedAt", "temporal", "actions"]), additionalProperties: false, properties: { state: { enum: ["OFFERED"] } } },
      { required: expect.arrayContaining(["closureReason", "evaluatedAt", "temporal", "actions"]), additionalProperties: false, properties: { state: { enum: ["CLOSED"] }, closureReason: { enum: ["ACCEPTED", "EXPIRED", "WITHDRAWN"] } } },
    ],
  });
});

it("publishes the current reservation query with synthetic identity and evaluated temporal state", async () => {
  const document = await readApiContract(schedulingApi());
  const operation = document.paths["/reservations/{id}"]?.get;
  expect(operation).toBeDefined();
  expect(Object.keys(operation.responses).sort()).toEqual(["200", "400", "404", "500", "503"]);
  expect(operation.parameters).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "id", in: "path", required: true, schema: expect.objectContaining({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" }) }),
    expect.objectContaining({ name: "x-patient-id", in: "header", required: true }),
  ]));
  expect(operation.parameters).toHaveLength(2);
  const schema = operation.responses["200"].content!["application/json"].schema;
  expect(schema).toMatchObject({
    required: expect.arrayContaining(["id", "slotId", "state", "createdAt", "expiresAt", "startsAt", "endsAt", "evaluatedAt", "temporal", "actions"]),
    additionalProperties: false,
    properties: {
      state: { enum: ["HELD", "OFFERED", "CONFIRMED", "CANCELLED", "EXPIRED"] },
      temporal: { required: ["expired", "closurePending"], additionalProperties: false },
      actions: { required: ["canConfirm", "canCancel", "canRejectOffer"], additionalProperties: false },
    },
  });
  for (const meaning of ["evaluatedAt", "closurePending", "no escribe", "CONFIRMED", "igualdad", "falsificable"]) expect(operation.description).toContain(meaning);
});

it("publishes confirmation without a required idempotency key and retains reservation conflicts", async () => {
  const document = await readApiContract(schedulingApi());
  const operation = document.paths["/reservations/{id}/confirm"]?.post;
  expect(operation).toBeDefined();
  expect(operation).not.toHaveProperty("requestBody");
  expect(operation.parameters?.map(({ name, in: location }) => `${location}:${name}`).sort()).toEqual(["header:x-patient-id", "path:id"]);
  expect(Object.keys(operation.responses).sort()).toEqual(["200", "400", "404", "409", "500", "503"]);
  expect(operation.responses["200"].content!["application/json"].schema).toMatchObject({ additionalProperties: false, properties: { state: { enum: ["CONFIRMED"] } } });
  expect(operation.responses["409"].content!["application/json"].schema).toMatchObject({
    oneOf: [
      { required: expect.arrayContaining(["id", "slotId", "state", "createdAt", "expiresAt", "startsAt", "endsAt", "code"]), additionalProperties: false, properties: { state: { enum: ["EXPIRED"] }, code: { enum: ["RESERVATION_EXPIRED"] } } },
      { required: expect.arrayContaining(["id", "state", "code"]), additionalProperties: false, properties: { state: { enum: ["CANCELLED"] }, code: { enum: ["RESERVATION_STATE_CONFLICT"] } } },
    ],
  });
  for (const meaning of ["misma identidad", "estado actual", "CANCELLED", "comprometerse", "igualdad"]) expect(operation.description).toContain(meaning);
});

it("publishes cancellation with its real terminal and started-appointment conflicts", async () => {
  const document = await readApiContract(schedulingApi());
  const operation = document.paths["/reservations/{id}/cancel"]?.post;
  expect(operation).toBeDefined();
  expect(operation).not.toHaveProperty("requestBody");
  expect(operation.parameters?.map(({ name, in: location }) => `${location}:${name}`).sort()).toEqual(["header:x-patient-id", "path:id"]);
  expect(Object.keys(operation.responses).sort()).toEqual(["200", "400", "404", "409", "500", "503"]);
  expect(operation.responses["200"].content!["application/json"].schema).toMatchObject({ additionalProperties: false, properties: { state: { enum: ["CANCELLED"] } } });
  expect(operation.responses["409"].content!["application/json"].schema).toMatchObject({
    oneOf: expect.arrayContaining([
      expect.objectContaining({ required: expect.arrayContaining(["id", "slotId", "state", "createdAt", "expiresAt", "startsAt", "endsAt", "code"]), additionalProperties: false, properties: expect.objectContaining({ state: { type: "string", enum: ["CONFIRMED"] }, code: { type: "string", enum: ["APPOINTMENT_STARTED"] } }) }),
      expect.objectContaining({ properties: expect.objectContaining({ state: { type: "string", enum: ["EXPIRED"] }, code: { type: "string", enum: ["RESERVATION_EXPIRED"] } }) }),
      expect.objectContaining({ properties: expect.objectContaining({ state: { type: "string", enum: ["OFFERED"] }, code: { type: "string", enum: ["RESERVATION_STATE_CONFLICT"] } }) }),
      expect.objectContaining({ properties: expect.objectContaining({ state: { type: "string", enum: ["CANCELLED"] }, code: { type: "string", enum: ["RESERVATION_STATE_CONFLICT"] } }) }),
    ]),
  });
  for (const meaning of ["después del inicio", "OFFERED", "comprometerse", "Idempotency-Key"]) expect(operation.description).toContain(meaning);
});

it("publishes hold creation headers, no body and only its applicable responses", async () => {
  const document = await readApiContract(schedulingApi());
  const operation = document.paths["/slots/{id}/holds"].post;
  expect(operation).not.toHaveProperty("requestBody");
  expect(Object.keys(operation.responses).sort()).toEqual(["201", "400", "404", "409", "500", "503"]);
  expect(operation.parameters).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "x-patient-id", in: "header", required: true, schema: expect.objectContaining({ type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" }) }),
    expect.objectContaining({ name: "idempotency-key", in: "header", required: true, schema: expect.objectContaining({ type: "string", minLength: 1, maxLength: 200, pattern: "^[!-~]+$" }) }),
  ]));
  expect(operation.parameters).toHaveLength(3);
  for (const meaning of ["TTL", "10 minutos", "menor", "igualdad", "revalidan", "histórico", "no se guardan", "paciente y operación"]) expect(operation.description).toContain(meaning);
});

it.each([
  { error: Object.assign(new Error("Synthetic PostgreSQL connection failure"), { code: "ECONNREFUSED" }), status: 503, code: "DEPENDENCY_UNAVAILABLE" },
  { error: new Error("Synthetic unexpected database failure"), status: 500, code: "INTERNAL_ERROR" },
])("validates every scheduling route error at the database boundary: $status/$code", async ({ error, status, code }) => {
  const pool = createDatabasePool("postgresql://synthetic:synthetic@127.0.0.1:1/synthetic");
  vi.spyOn(pool, "connect").mockRejectedValue(error);
  vi.spyOn(pool, "query").mockRejectedValue(error);
  const app = buildApi(async () => {}, async () => ({ evaluatedAt: "2030-01-01T00:00:00.000Z", slots: [] }), schedulingUseCases(postgresScheduling(pool)));
  apis.push(app);
  try {
    const document = await readApiContract(app);
    for (const { method, path, url } of [
      { method: "POST", path: "/slots/{id}/holds", url: "/slots/slot-north-mri-1/holds" },
      { method: "GET", path: "/reservations/{id}", url: "/reservations/10000000-0000-4000-8000-000000000001" },
      { method: "POST", path: "/reservations/{id}/confirm", url: "/reservations/10000000-0000-4000-8000-000000000001/confirm" },
      { method: "POST", path: "/reservations/{id}/cancel", url: "/reservations/10000000-0000-4000-8000-000000000001/cancel" },
      { method: "POST", path: "/reservations/{id}/reject", url: "/reservations/10000000-0000-4000-8000-000000000001/reject" },
      { method: "POST", path: "/waiting-list-entries", url: "/waiting-list-entries" },
      { method: "GET", path: "/waiting-list-entries/{id}", url: "/waiting-list-entries/20000000-0000-4000-8000-000000000001" },
      { method: "POST", path: "/waiting-list-entries/{id}/withdraw", url: "/waiting-list-entries/20000000-0000-4000-8000-000000000001/withdraw" },
    ] as const) {
      const response = await app.inject({ method, url, headers: { "x-patient-id": "patient-ana", "idempotency-key": "synthetic-error" }, payload: path === "/waiting-list-entries" ? { hospitalId: "hospital-south", testTypeId: "mri" } : undefined });
      expect(response.statusCode, path).toBe(status);
      expect(response.json()).toEqual({ code });
      expectContractResponse(document, method, path, response);
    }
  } finally { vi.restoreAllMocks(); await pool.end(); }
});

it("preserves invalid identity and path responses on every identified scheduling resource", async () => {
  const app = schedulingApi();
  const document = await readApiContract(app);
  for (const { method, path, url } of [
    { method: "POST", path: "/slots/{id}/holds", url: "/slots/ID/holds" },
    { method: "GET", path: "/reservations/{id}", url: "/reservations/ID" },
    { method: "POST", path: "/reservations/{id}/confirm", url: "/reservations/ID/confirm" },
    { method: "POST", path: "/reservations/{id}/cancel", url: "/reservations/ID/cancel" },
    { method: "POST", path: "/reservations/{id}/reject", url: "/reservations/ID/reject" },
    { method: "GET", path: "/waiting-list-entries/{id}", url: "/waiting-list-entries/ID" },
    { method: "POST", path: "/waiting-list-entries/{id}/withdraw", url: "/waiting-list-entries/ID/withdraw" },
  ] as const) {
    for (const headers of [{}, { "x-patient-id": "invalid patient" }, { "x-patient-id": "x".repeat(101) }]) {
      const response = await app.inject({ method, url, headers: { ...headers, "idempotency-key": "synthetic-invalid" } });
      expect(response.statusCode, path).toBe(400);
      expect(response.json()).toEqual({ code: "INVALID_REQUEST" });
      expectContractResponse(document, method, path, response);
    }
    const response = await app.inject({ method, url: url.replace("ID", "invalid%20id"), headers: { "x-patient-id": "patient-ana", "idempotency-key": "synthetic-invalid" } });
    expect(response.statusCode, path).toBe(400);
    expect(response.json()).toEqual({ code: "INVALID_REQUEST" });
    expectContractResponse(document, method, path, response);
  }
});

it("preserves waiting list creation validation for identity, keys, JSON scope and content type", async () => {
  const app = schedulingApi();
  const document = await readApiContract(app);
  const headers = { "x-patient-id": "patient-ana", "idempotency-key": "demo-wait-1" };
  const scope = { hospitalId: "hospital-south", testTypeId: "mri" };
  for (const request of [
    { headers: { "idempotency-key": "demo-wait-1" }, payload: scope },
    { headers: { ...headers, "x-patient-id": "invalid patient" }, payload: scope },
    { headers: { "x-patient-id": "patient-ana" }, payload: scope },
    { headers: { ...headers, "idempotency-key": "invalid key" }, payload: scope },
    { headers: { ...headers, "idempotency-key": "x".repeat(201) }, payload: scope },
    { headers },
    { headers, payload: { hospitalId: "hospital-south" } },
    { headers, payload: { ...scope, patientId: "patient-bruno" } },
    { headers, payload: { ...scope, testTypeId: 1 } },
    { headers, payload: { ...scope, hospitalId: "invalid hospital" } },
    { headers: { ...headers, "content-type": "application/json" }, payload: "{" },
    { headers: { ...headers, "content-type": "application/xml" }, payload: "<scope/>" },
  ]) {
    const response = await app.inject({ method: "POST", url: "/waiting-list-entries", ...request });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "INVALID_REQUEST" });
    expectContractResponse(document, "POST", "/waiting-list-entries", response);
  }
});

it("serves an independently valid OpenAPI 3.2.1 document generated from the API", async () => {
  const response = await api().inject({ url: "/openapi.json" });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toContain("application/json");
  const document = response.json();
  expect(document.openapi).toBe("3.2.1");
  await validateApiDocument(document);
  expect(document.paths["/health/live"].get).toBeDefined();
  expect(document.paths["/health/ready"].get).toBeDefined();
  expect(document.paths["/slots"].get).toBeDefined();
});

it("serves Swagger UI and its assets with the downloadable contract as its source", async () => {
  const app = api();
  const entry = await app.inject({ url: "/docs" });
  expect([200, 301, 302, 307, 308]).toContain(entry.statusCode);
  const page = entry.statusCode === 200 ? entry : await app.inject({ url: entry.headers.location! });
  expect(page.statusCode).toBe(200);
  expect(page.headers["content-type"]).toContain("text/html");
  expect(page.body).toContain("swagger-ui");
  const initializer = await app.inject({ url: "/docs/static/swagger-initializer.js" });
  expect(initializer.statusCode).toBe(200);
  expect(initializer.body).toContain('"url":"/openapi.json"');
  for (const asset of ["swagger-ui-bundle.js", "swagger-ui-standalone-preset.js", "swagger-ui.css"]) {
    const response = await app.inject({ url: `/docs/static/${asset}` });
    expect(response.statusCode, asset).toBe(200);
    expect(response.headers["content-type"]).toMatch(/javascript|css/);
    expect(response.body.length).toBeGreaterThan(1000);
  }
});

it("describes and validates the live, ready and unavailable health representations", async () => {
  let postgresAvailable = true;
  const app = buildApi(async () => { if (!postgresAvailable) throw new Error("Synthetic PostgreSQL failure"); }, async () => ({ evaluatedAt: "2030-01-01T00:00:00.000Z", slots: [] }));
  apis.push(app);
  const document = await readApiContract(app);
  const live = await app.inject({ url: "/health/live" });
  expect(live.json()).toEqual({ service: "diagnostic-appointments-api", status: "alive" });
  expectContractResponse(document, "GET", "/health/live", live);
  const ready = await app.inject({ url: "/health/ready" });
  expect(ready.statusCode).toBe(200);
  expect(ready.json()).toEqual({ status: "ready", dependencies: { postgres: "up" } });
  expectContractResponse(document, "GET", "/health/ready", ready);
  postgresAvailable = false;
  const unavailable = await app.inject({ url: "/health/ready" });
  expect(unavailable.statusCode).toBe(503);
  expect(unavailable.json()).toEqual({ status: "not_ready", dependencies: { postgres: "down" } });
  expectContractResponse(document, "GET", "/health/ready", unavailable);
  const stillAlive = await app.inject({ url: "/health/live" });
  expect(stillAlive.statusCode).toBe(200);
  expectContractResponse(document, "GET", "/health/live", stillAlive);
  expect(document.paths["/health/ready"].get.description).toContain("RabbitMQ");
});

it("documents the exact agenda validation bodies without changing invalid input behavior", async () => {
  const app = api();
  const document = await readApiContract(app);
  const invalidQuery = await app.inject({ url: "/slots?hospitalId=hospital-north" });
  expect(invalidQuery.statusCode).toBe(400);
  expect(invalidQuery.json()).toEqual({ code: "INVALID_REQUEST" });
  expectContractResponse(document, "GET", "/slots", invalidQuery);
  const invalidInterval = await app.inject({ url: "/slots", query: { hospitalId: "hospital-north", testTypeId: "mri", from: "2030-01-01T00:00:00", to: "2100-01-01T00:00:00Z" } });
  expect(invalidInterval.statusCode).toBe(400);
  expect(invalidInterval.json()).toEqual({ code: "INVALID_INTERVAL", message: "Invalid instant: use ISO 8601 with an explicit offset and at most three fractional digits" });
  expectContractResponse(document, "GET", "/slots", invalidInterval);
  const reversedInterval = await app.inject({ url: "/slots", query: { hospitalId: "hospital-north", testTypeId: "mri", from: "2100-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" } });
  expect(reversedInterval.json()).toEqual({ code: "INVALID_INTERVAL", message: "from must precede to" });
  expectContractResponse(document, "GET", "/slots", reversedInterval);
});

it.each([
  { error: new DependencyUnavailable(new Error("Synthetic database failure")), status: 503, code: "DEPENDENCY_UNAVAILABLE" },
  { error: new Error("Synthetic unexpected failure"), status: 500, code: "INTERNAL_ERROR" },
])("documents agenda dependency-boundary failure $status/$code", async ({ error, status, code }) => {
  const app = buildApi(async () => {}, async () => { throw error; });
  apis.push(app);
  const document = await readApiContract(app);
  const response = await app.inject({ url: "/slots", query: { hospitalId: "hospital-north", testTypeId: "mri", from: "2020-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" } });
  expect(response.statusCode).toBe(status);
  expect(response.json()).toEqual({ code });
  expectContractResponse(document, "GET", "/slots", response);
});

it("covers all eleven operations against the independent complete public route inventory", async () => {
  const app = schedulingApi();
  const inventory = captureApiRoutes(app);
  const document = await readApiContract(app);
  expectContractCoverage(document, inventory, [
    "GET /health/live", "GET /health/ready", "GET /slots",
    "GET /reservations/{id}", "POST /slots/{id}/holds",
    "POST /reservations/{id}/cancel", "POST /reservations/{id}/confirm",
    "GET /waiting-list-entries/{id}", "POST /reservations/{id}/reject",
    "POST /waiting-list-entries", "POST /waiting-list-entries/{id}/withdraw",
  ]);
  expect([...inventory.derivedHeads].sort()).toEqual(["HEAD /health/live", "HEAD /health/ready", "HEAD /reservations/{id}", "HEAD /slots", "HEAD /waiting-list-entries/{id}"]);
  expect(inventory.artifacts).toContain("GET /openapi.json");
  expect(inventory.artifacts).toContain("GET /docs");
});

it("rejects broken references and malformed schemas in the downloaded document", async () => {
  const app = api();
  const document = (await app.inject({ url: "/openapi.json" })).json();
  const brokenReference = structuredClone(document);
  brokenReference.paths["/health/live"].get.responses["200"].content["application/json"].schema = { $ref: "#/components/schemas/MissingHealth" };
  await expect(validateApiDocument(brokenReference)).rejects.toThrow();
  const brokenSchema = structuredClone(document);
  brokenSchema.paths["/health/live"].get.responses["200"].content["application/json"].schema = { type: "unknown-type" };
  await expect(validateApiDocument(brokenSchema)).rejects.toThrow();
});

it("fails response checks for undeclared status, content type and incompatible bodies", async () => {
  const app = api();
  const document = await readApiContract(app);
  const response = await app.inject({ url: "/health/live" });
  const missingStatus = structuredClone(document);
  delete missingStatus.paths["/health/live"].get.responses["200"];
  expect(() => expectContractResponse(missingStatus, "GET", "/health/live", response)).toThrow();
  const wrongMedia = structuredClone(document);
  wrongMedia.paths["/health/live"].get.responses["200"].content = { "text/plain": { schema: { type: "string" } } };
  expect(() => expectContractResponse(wrongMedia, "GET", "/health/live", response)).toThrow();
  const wrongBody = structuredClone(document);
  wrongBody.paths["/health/live"].get.responses["200"].content = { "application/json": { schema: { type: "object", required: ["missingField"] } } };
  expect(() => expectContractResponse(wrongBody, "GET", "/health/live", response)).toThrow();
});

it("does not exclude an independent HEAD or an unplanned public operation from coverage", async () => {
  const app = api();
  const inventory = captureApiRoutes(app);
  app.register(async (routes) => {
    routes.head("/independent-head", async (_request, reply) => reply.header("x-synthetic", "yes").send());
    routes.get("/unplanned-operation", async () => ({ status: "synthetic" }));
  });
  const document = await readApiContract(app);
  expect(inventory.operations).toContain("HEAD /independent-head");
  expect(inventory.operations).toContain("GET /unplanned-operation");
  expect(document.paths["/unplanned-operation"]?.get).toBeDefined();
  expect(() => expectContractCoverage(document, inventory, ["GET /health/live", "GET /health/ready", "GET /slots"])).toThrow();
});

it("rejects a missing documented route even when the public inventory is unchanged", async () => {
  const app = api();
  const inventory = captureApiRoutes(app);
  const document = await readApiContract(app);
  expectContractCoverage(document, inventory, ["GET /health/live", "GET /health/ready", "GET /slots"]);
  delete document.paths["/slots"];
  expect(() => expectContractCoverage(document, inventory, ["GET /health/live", "GET /health/ready", "GET /slots"])).toThrow();
});

it("publishes the required agenda parameters with their real restrictions and temporal meaning", async () => {
  const document = await readApiContract(api());
  const operation = document.paths["/slots"].get;
  expect(operation.parameters).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "hospitalId", in: "query", required: true, schema: expect.objectContaining({ type: "string", minLength: 1, maxLength: 100 }) }),
    expect.objectContaining({ name: "testTypeId", in: "query", required: true, schema: expect.objectContaining({ type: "string", minLength: 1, maxLength: 100 }) }),
    expect.objectContaining({ name: "from", in: "query", required: true, schema: expect.objectContaining({ type: "string" }) }),
    expect.objectContaining({ name: "to", in: "query", required: true, schema: expect.objectContaining({ type: "string" }) }),
  ]));
  expect(operation.parameters).toHaveLength(4);
  for (const meaning of ["[from,to)", "estrictamente futuros", "offset explícito", "UTC", "milisegundos", "directlyBookable", "sin reservar capacidad"]) {
    expect(operation.description).toContain(meaning);
  }
});
