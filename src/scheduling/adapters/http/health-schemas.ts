import type { FastifySchema } from "fastify";

export const liveSchema: FastifySchema = {
  operationId: "getLiveness",
  tags: ["Salud"],
  summary: "Comprobar que el proceso de API está vivo",
  description: "No consulta dependencias. Un proceso vivo no acredita disponibilidad para operar.",
  response: {
    200: {
      description: "El proceso HTTP está vivo.",
      type: "object", required: ["service", "status"], additionalProperties: false,
      properties: { service: { type: "string", const: "diagnostic-appointments-api" }, status: { type: "string", const: "alive" } },
      examples: [{ service: "diagnostic-appointments-api", status: "alive" }],
    },
  },
};

export const readySchema: FastifySchema = {
  operationId: "getReadiness",
  tags: ["Salud"],
  summary: "Comprobar la disponibilidad de la API",
  description: "Consulta PostgreSQL. La disponibilidad de la API es independiente de RabbitMQ: el negocio conserva el trabajo de mensajería en outbox aunque el broker no esté disponible.",
  response: {
    200: {
      description: "PostgreSQL responde; la API está disponible.",
      type: "object", required: ["status", "dependencies"], additionalProperties: false,
      properties: {
        status: { type: "string", const: "ready" },
        dependencies: { type: "object", required: ["postgres"], additionalProperties: false, properties: { postgres: { type: "string", const: "up" } } },
      },
      examples: [{ status: "ready", dependencies: { postgres: "up" } }],
    },
    503: {
      description: "La comprobación de PostgreSQL ha fallado.",
      type: "object", required: ["status", "dependencies"], additionalProperties: false,
      properties: {
        status: { type: "string", const: "not_ready" },
        dependencies: { type: "object", required: ["postgres"], additionalProperties: false, properties: { postgres: { type: "string", const: "down" } } },
      },
      examples: [{ status: "not_ready", dependencies: { postgres: "down" } }],
    },
  },
};
