import type { FastifySchema } from "fastify";
import { invalidRequestSchema, dependencyUnavailableSchema, internalErrorSchema } from "./error-schemas.ts";

const utcInstant = { type: "string", format: "date-time", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" };

export const agendaSchema: FastifySchema = {
  operationId: "listSlots",
  tags: ["Agenda"],
  summary: "Consultar la agenda de un hospital y tipo de prueba",
  description: "Fotografía evaluada en evaluatedAt, sin reservar capacidad. Filtra los inicios en [from,to), solo estrictamente futuros respecto a evaluatedAt; from debe preceder a to. Entrada ISO 8601 con zona Z u offset explícito y máximo tres decimales de segundo; las fechas deben existir en el calendario. Salida UTC con milisegundos. Orden por startsAt y, en caso de empate, id. directlyBookable indica si se admite un bloqueo directo en esa fotografía: una ocupación o espera elegible con prioridad lo impiden, incluso con un cierre por caducidad pendiente. No expone reservas, pacientes ni inscripciones ajenas. Un ámbito inexistente devuelve slots vacío. No requiere identidad ni cuerpo.",
  querystring: {
    type: "object", required: ["hospitalId", "testTypeId", "from", "to"], additionalProperties: false,
    properties: {
      hospitalId: { type: "string", minLength: 1, maxLength: 100, description: "Identificador de hospital.", examples: ["hospital-north"] },
      testTypeId: { type: "string", minLength: 1, maxLength: 100, description: "Tipo de prueba; agrupa recursos equivalentes del hospital.", examples: ["mri"] },
      from: { type: "string", description: "Límite inclusivo del inicio: ISO 8601, zona u offset explícito y máximo milisegundos. Se valida junto con to; sus errores devuelven INVALID_INTERVAL.", examples: ["2020-01-01T00:00:00Z"] },
      to: { type: "string", description: "Límite exclusivo del inicio, posterior a from: ISO 8601 con zona u offset explícito y máximo milisegundos.", examples: ["2100-01-01T00:00:00Z"] },
    },
  },
  response: {
    500: internalErrorSchema,
    503: dependencyUnavailableSchema,
    400: {
      description: "Parámetros inválidos (INVALID_REQUEST) o intervalo inválido (INVALID_INTERVAL con el mensaje original).",
      oneOf: [
        invalidRequestSchema,
        {
          type: "object", required: ["code", "message"], additionalProperties: false,
          properties: { code: { type: "string", const: "INVALID_INTERVAL" }, message: { type: "string", enum: ["from must precede to", "Invalid instant: use ISO 8601 with an explicit offset and at most three fractional digits"] } },
        },
      ],
      examples: [{ code: "INVALID_REQUEST" }, { code: "INVALID_INTERVAL", message: "from must precede to" }, { code: "INVALID_INTERVAL", message: "Invalid instant: use ISO 8601 with an explicit offset and at most three fractional digits" }],
    },
    200: {
      description: "Agenda del ámbito en el instante indicado, sin datos de pacientes.",
      type: "object", required: ["evaluatedAt", "slots"], additionalProperties: false,
      properties: {
        evaluatedAt: utcInstant,
        slots: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            required: ["id", "resourceId", "hospitalId", "testTypeId", "startsAt", "endsAt", "directlyBookable"],
            properties: {
              id: { type: "string" }, resourceId: { type: "string" }, hospitalId: { type: "string" }, testTypeId: { type: "string" },
              startsAt: utcInstant, endsAt: utcInstant,
              directlyBookable: { type: "boolean", description: "Admite un bloqueo directo según ocupación y prioridad en evaluatedAt. No garantiza la decisión de una petición posterior." },
            },
          },
        },
      },
      examples: [{ evaluatedAt: "2030-01-01T00:00:00.000Z", slots: [{ id: "slot-north-mri-1", resourceId: "scanner-north-1", hospitalId: "hospital-north", testTypeId: "mri", startsAt: "2030-01-02T09:00:00.000Z", endsAt: "2030-01-02T09:30:00.000Z", directlyBookable: true }] }],
    },
  },
};
