import Fastify from "fastify";
import type { AgendaReader } from "../../application/agenda.ts";
import { parseExternalInstant } from "../../domain/instant.ts";

export function buildApi(checkPostgres: () => Promise<void>, readAgenda: AgendaReader) {
  const api = Fastify({ logger: true, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });

  api.get<{ Querystring: { hospitalId: string; testTypeId: string; from: string; to: string } }>("/slots", {
    schema: {
      querystring: {
        type: "object",
        required: ["hospitalId", "testTypeId", "from", "to"],
        properties: {
          hospitalId: { type: "string", minLength: 1, maxLength: 100 },
          testTypeId: { type: "string", minLength: 1, maxLength: 100 },
          from: { type: "string" },
          to: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    let from: Date;
    let to: Date;
    try {
      from = parseExternalInstant(request.query.from);
      to = parseExternalInstant(request.query.to);
      if (from >= to) throw new Error("from must precede to");
    } catch (error) {
      return reply.code(400).send({ code: "INVALID_INTERVAL", message: error instanceof Error ? error.message : "Invalid interval" });
    }
    return readAgenda({ ...request.query, from, to });
  });

  api.get("/health/live", async () => ({
    service: "diagnostic-appointments-api",
    status: "alive",
  }));

  api.get("/health/ready", async (_request, reply) => {
    try {
      await checkPostgres();
      return { status: "ready", dependencies: { postgres: "up" } };
    } catch {
      return reply.code(503).send({
        status: "not_ready",
        dependencies: { postgres: "down" },
      });
    }
  });

  return api;
}
