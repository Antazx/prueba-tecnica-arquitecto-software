import { expect } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { Validator } from "@seriousme/openapi-schema-validator";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

const { default: addFormats } = addFormatsModule;

interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean; schema: Record<string, unknown> }>;
  responses: Record<string, { description: string; content?: Record<string, { schema: object }> }>;
}

export interface ApiDocument extends Record<string, unknown> {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
}

export async function readApiContract(api: FastifyInstance | string) {
  let document: ApiDocument;
  if (typeof api === "string") {
    const response = await fetch(`${api}/openapi.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    document = await response.json() as ApiDocument;
  } else {
    const response = await api.inject({ url: "/openapi.json" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    document = response.json<ApiDocument>();
  }
  expect(document.openapi).toBe("3.2.1");
  return validateApiDocument(document);
}

export async function validateApiDocument(document: ApiDocument) {
  const validator = new Validator();
  const result = await validator.validate(document);
  expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  const resolved = validator.resolveRefs() as ApiDocument;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  function compileSchema(schema: unknown) {
    if (typeof schema !== "boolean" && (schema === null || typeof schema !== "object")) throw new Error("Invalid JSON Schema");
    ajv.compile(schema);
  }
  // The OpenAPI meta-schema treats Schema Objects as extension points; compile them independently.
  function checkSchemas(value: unknown) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "schema") compileSchema(child);
      else if (key === "schemas" && child && typeof child === "object") {
        for (const schema of Object.values(child)) compileSchema(schema);
      } else checkSchemas(child);
    }
  }
  checkSchemas(resolved);
  return resolved;
}

export function expectContractResponse(document: ApiDocument, method: string, path: string, response: Pick<LightMyRequestResponse, "statusCode" | "headers" | "json">) {
  const operation = document.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} must be documented`).toBeDefined();
  const declared = operation.responses[String(response.statusCode)];
  expect(declared, `${method} ${path} must document ${response.statusCode}`).toBeDefined();
  const mediaType = String(response.headers["content-type"]).split(";", 1)[0];
  const schema = declared.content?.[mediaType]?.schema;
  expect(schema, `${response.statusCode} must document ${mediaType}`).toBeDefined();
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema!);
  expect(validate(response.json()), JSON.stringify(validate.errors)).toBe(true);
}

export async function expectNetworkContractResponse(document: ApiDocument, method: string, path: string, response: Response) {
  const body = await response.json();
  expectContractResponse(document, method, path, {
    statusCode: response.status, headers: { "content-type": response.headers.get("content-type") ?? "" }, json: () => body,
  });
  return body;
}

export function captureApiRoutes(api: FastifyInstance) {
  const inventory = { operations: [] as string[], derivedHeads: [] as string[], artifacts: [] as string[] };
  const gets = new Map<string, { handler: unknown; schema: unknown }>();
  api.addHook("onRoute", (route) => {
    const path = route.url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      const operation = `${method} ${path}`;
      if (path === "/openapi.json" || path === "/docs" || path.startsWith("/docs/")) {
        inventory.artifacts.push(operation);
        continue;
      }
      // Fastify derives HEAD by copying the GET handler and schema. An independent HEAD stays public.
      const get = gets.get(path);
      if (method === "HEAD" && get?.handler === route.handler && get.schema === route.schema) {
        inventory.derivedHeads.push(operation);
      } else {
        inventory.operations.push(operation);
      }
      if (method === "GET") gets.set(path, { handler: route.handler, schema: route.schema });
    }
  });
  return inventory;
}

export function expectContractCoverage(document: ApiDocument, inventory: ReturnType<typeof captureApiRoutes>, covered: string[]) {
  const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace", "query"]);
  const documented = Object.entries(document.paths).flatMap(([path, item]) =>
    Object.keys(item).filter((method) => methods.has(method)).map((method) => `${method.toUpperCase()} ${path}`));
  expect(documented.sort()).toEqual([...covered].sort());
  expect([...inventory.operations].sort()).toEqual([...covered].sort());
  expect(new Set(covered).size).toBe(covered.length);
}
