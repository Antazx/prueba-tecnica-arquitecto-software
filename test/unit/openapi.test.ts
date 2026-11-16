import { afterEach, expect, it } from "vitest";
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

it("tracks the three documented operations against the complete registered public API", async () => {
  const app = buildApi(async () => {}, async () => ({ evaluatedAt: "2030-01-01T00:00:00.000Z", slots: [] }), schedulingUseCases(postgresScheduling(createDatabasePool("postgresql://synthetic:synthetic@127.0.0.1:1/synthetic"))));
  apis.push(app);
  const inventory = captureApiRoutes(app);
  const document = await readApiContract(app);
  expectContractCoverage(document, inventory, [
    "GET /health/live", "GET /health/ready", "GET /slots",
  ], [
    "GET /reservations/{id}", "GET /waiting-list-entries/{id}",
    "POST /reservations/{id}/cancel", "POST /reservations/{id}/confirm", "POST /reservations/{id}/reject",
    "POST /slots/{id}/holds", "POST /waiting-list-entries", "POST /waiting-list-entries/{id}/withdraw",
  ]);
  expect(inventory.derivedHeads).toEqual(expect.arrayContaining(["HEAD /health/live", "HEAD /health/ready", "HEAD /slots"]));
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
  app.head("/independent-head", async (_request, reply) => reply.header("x-synthetic", "yes").send());
  app.get("/unplanned-operation", async () => ({ status: "synthetic" }));
  const document = await readApiContract(app);
  expect(inventory.operations).toContain("HEAD /independent-head");
  expect(inventory.operations).toContain("GET /unplanned-operation");
  expect(() => expectContractCoverage(document, inventory, ["GET /health/live", "GET /health/ready", "GET /slots"])).toThrow();
  const missingOperation = structuredClone(document);
  delete missingOperation.paths["/slots"];
  expect(() => expectContractCoverage(missingOperation, inventory, ["GET /health/live", "GET /health/ready", "GET /slots"])).toThrow();
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
