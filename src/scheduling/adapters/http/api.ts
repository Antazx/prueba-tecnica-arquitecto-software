import Fastify from "fastify";
import type { AgendaReader } from "../../application/agenda.ts";
import { parseExternalInstant } from "../../domain/instant.ts";
import type { SchedulingUseCases } from "../../application/reservations.ts";
import { DependencyUnavailable } from "../../application/scheduling.ts";

export function buildApi(checkPostgres: () => Promise<void>, readAgenda: AgendaReader, scheduling?: SchedulingUseCases) {
  const api = Fastify({ logger: true, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });

  api.setErrorHandler((error, request, reply) => {
    if (error instanceof DependencyUnavailable) {
      request.log.warn({ err: error }, "Scheduling storage unavailable");
      return reply.code(503).send({ code: "DEPENDENCY_UNAVAILABLE" });
    }
    if (error instanceof Error && "validation" in error) return reply.code(400).send({ code: "INVALID_REQUEST" });
    if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" &&
        error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    }
    request.log.error({ err: error }, "Request failed");
    return reply.code(500).send({ code: "INTERNAL_ERROR" });
  });

  if (scheduling) {
    const id = { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" };
    const patientHeaders = { type: "object", required: ["x-patient-id"], properties: { "x-patient-id": id } };
    const params = { type: "object", required: ["id"], properties: { id }, additionalProperties: false };
    api.get<{ Params: { id: string }; Headers: { "x-patient-id": string } }>("/waiting-list-entries/:id", {
      schema: { params, headers: patientHeaders },
    }, async (request, reply) => {
      const result = await scheduling.getWaitingListEntry(request.headers["x-patient-id"], request.params.id);
      return reply.code(result.status).send(result.body);
    });
    api.post<{ Params: { id: string }; Headers: { "x-patient-id": string } }>("/waiting-list-entries/:id/withdraw", {
      schema: { params, headers: patientHeaders },
    }, async (request, reply) => {
      if (request.body !== undefined) return reply.code(400).send({ code: "BODY_NOT_ALLOWED" });
      const result = await scheduling.withdrawWaitingListEntry(request.headers["x-patient-id"], request.params.id);
      return reply.code(result.status).send(result.body);
    });
    api.post<{ Body: { hospitalId: string; testTypeId: string }; Headers: { "x-patient-id": string; "idempotency-key": string } }>("/waiting-list-entries", {
      schema: {
        headers: { ...patientHeaders, required: ["x-patient-id", "idempotency-key"], properties: {
          ...patientHeaders.properties, "idempotency-key": { type: "string", minLength: 1, maxLength: 200, pattern: "^[!-~]+$" },
        } },
        body: { type: "object", required: ["hospitalId", "testTypeId"], properties: { hospitalId: id, testTypeId: id }, additionalProperties: false },
      },
    }, async (request, reply) => {
      const result = await scheduling.joinWaitingList(request.headers["x-patient-id"], request.body, request.headers["idempotency-key"]);
      return reply.code(result.status).send(result.body);
    });
    api.post<{ Params: { id: string }; Headers: { "x-patient-id": string; "idempotency-key": string } }>("/slots/:id/holds", {
      schema: { params, headers: {
        ...patientHeaders,
        required: ["x-patient-id", "idempotency-key"],
        properties: { ...patientHeaders.properties, "idempotency-key": { type: "string", minLength: 1, maxLength: 200, pattern: "^[!-~]+$" } },
      } },
    }, async (request, reply) => {
      // Ownership and deadline come exclusively from the presented identity and the server.
      if (request.body !== undefined) return reply.code(400).send({ code: "BODY_NOT_ALLOWED" });
      const result = await scheduling.createHold(request.headers["x-patient-id"], request.params.id, request.headers["idempotency-key"]);
      return reply.code(result.status).send(result.body);
    });
    api.post<{ Params: { id: string }; Headers: { "x-patient-id": string } }>("/reservations/:id/confirm", {
      schema: { params, headers: patientHeaders },
    }, async (request, reply) => {
      if (request.body !== undefined) return reply.code(400).send({ code: "BODY_NOT_ALLOWED" });
      const result = await scheduling.confirmReservation(request.headers["x-patient-id"], request.params.id);
      return reply.code(result.status).send(result.body);
    });
    api.post<{ Params: { id: string }; Headers: { "x-patient-id": string } }>("/reservations/:id/reject", {
      schema: { params, headers: patientHeaders },
    }, async (request, reply) => {
      if (request.body !== undefined) return reply.code(400).send({ code: "BODY_NOT_ALLOWED" });
      const result = await scheduling.rejectOffer(request.headers["x-patient-id"], request.params.id);
      return reply.code(result.status).send(result.body);
    });
    api.post<{ Params: { id: string }; Headers: { "x-patient-id": string } }>("/reservations/:id/cancel", {
      schema: { params, headers: patientHeaders },
    }, async (request, reply) => {
      if (request.body !== undefined) return reply.code(400).send({ code: "BODY_NOT_ALLOWED" });
      const result = await scheduling.cancelReservation(request.headers["x-patient-id"], request.params.id);
      return reply.code(result.status).send(result.body);
    });
    api.get<{ Params: { id: string }; Headers: { "x-patient-id": string } }>("/reservations/:id", {
      schema: { params, headers: patientHeaders },
    }, async (request, reply) => {
      const result = await scheduling.getReservation(request.headers["x-patient-id"], request.params.id);
      return reply.code(result.status).send(result.body);
    });
  }

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
