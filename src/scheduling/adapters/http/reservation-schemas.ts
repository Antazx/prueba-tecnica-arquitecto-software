import type { FastifySchema } from "fastify";
import { codeErrorSchema } from "./error-schemas.ts";
import { commandErrors, creationHeaders, idParams, patientHeaders, readErrors, utcInstantSchema } from "./scheduling-schemas.ts";

const reservationProperties = {
  id: { type: "string", format: "uuid", description: "Identidad estable de esta reserva; no cambia al confirmar." },
  slotId: { type: "string" },
  state: { type: "string", enum: ["HELD", "OFFERED", "CONFIRMED", "CANCELLED", "EXPIRED"] },
  createdAt: utcInstantSchema,
  expiresAt: { ...utcInstantSchema, description: "Plazo temporal original, conservado también después de confirmar o terminar. Una cita confirmada no vence por este plazo." },
  startsAt: utcInstantSchema, endsAt: utcInstantSchema,
};
const reservationShape = { type: "object", required: Object.keys(reservationProperties), additionalProperties: false, properties: reservationProperties };
export const reservationSchema = { $id: "Reservation", ...reservationShape };
const heldExample = {
  id: "10000000-0000-4000-8000-000000000001", slotId: "slot-north-mri-1", state: "HELD",
  createdAt: "2030-01-01T09:00:00.000Z", expiresAt: "2030-01-01T09:10:00.000Z",
  startsAt: "2030-01-02T09:00:00.000Z", endsAt: "2030-01-02T09:30:00.000Z",
};
export const heldReservationSchema = {
  $id: "HeldReservation", ...reservationShape,
  properties: { ...reservationProperties, state: { type: "string", const: "HELD" } }, examples: [heldExample],
};
export const confirmedReservationSchema = {
  $id: "ConfirmedReservation", ...reservationShape,
  properties: { ...reservationProperties, state: { type: "string", const: "CONFIRMED" } },
  examples: [{ ...heldExample, state: "CONFIRMED" }],
};
export const cancelledReservationSchema = {
  $id: "CancelledReservation", ...reservationShape,
  properties: { ...reservationProperties, state: { type: "string", const: "CANCELLED" } },
  examples: [{ ...heldExample, state: "CANCELLED" }],
};

export function reservationConflictSchema(code: string, state: string, description: string) {
  return {
    ...reservationShape, description, required: [...reservationShape.required, "code"],
    properties: { ...reservationProperties, state: { type: "string", const: state }, code: { type: "string", const: code } },
    examples: [{ ...heldExample, state, code }],
  };
}

export const confirmReservationSchema: FastifySchema = {
  operationId: "confirmReservation", tags: ["Reservas"], summary: "Confirmar un bloqueo propio o aceptar una oferta propia",
  description: "Sin cuerpo ni Idempotency-Key obligatoria. HELD u OFFERED vigente pasa a CONFIRMED con la misma identidad de reserva. Repetir confirma el estado actual: éxito mientras siga CONFIRMED, incluso después del inicio; si después fue CANCELLED, devuelve conflicto con su identificación y estado actual, sin replay histórico. Se revalidan estado y tiempo al decidir: la igualdad con expiresAt o startsAt ya vence una temporal. Una caducidad puede comprometerse junto con su liberación durable aunque la respuesta sea 409 RESERVATION_EXPIRED; no amplía el plazo. Recurso ajeno e inexistente comparten NOT_FOUND; la identidad sintética es falsificable.",
  params: idParams, headers: patientHeaders,
  response: {
    ...commandErrors,
    200: { $ref: "ConfirmedReservation#", description: "Cita confirmada con la identidad y el plazo original de la reserva." },
    409: {
      description: "La reserva venció o ya fue cancelada; conserva toda la representación de reserva y añade code.",
      oneOf: [
        reservationConflictSchema("RESERVATION_EXPIRED", "EXPIRED", "El cierre por caducidad ya está persistido o se compromete en esta decisión."),
        reservationConflictSchema("RESERVATION_STATE_CONFLICT", "CANCELLED", "La reserva ya está cancelada y no se puede confirmar."),
      ],
    },
  },
};

export const cancelReservationSchema: FastifySchema = {
  operationId: "cancelReservation", tags: ["Reservas"], summary: "Cancelar un bloqueo directo o cita confirmada propios",
  description: "Sin cuerpo ni Idempotency-Key obligatoria. Cancela HELD vigente o CONFIRMED antes de startsAt; una cancelación nueva de cita con igualdad o posterior al inicio devuelve APPOINTMENT_STARTED. OFFERED siempre produce RESERVATION_STATE_CONFLICT, incluso vencida: debe aceptarse, rechazarse o retirarse desde sus operaciones. Si el bloqueo ya venció, su cierre y liberación durable pueden comprometerse aunque se responda 409 RESERVATION_EXPIRED. Repetir una cancelación completada por esta operación conserva el éxito incluso después del inicio; una CANCELLED por rechazo o retirada produce conflicto. Estado y tiempo se revalidan al decidir. No amplía plazos ni cancela una reserva posterior del mismo hueco. Recurso ajeno e inexistente comparten NOT_FOUND; la identidad sintética es falsificable.",
  params: idParams, headers: patientHeaders,
  response: {
    ...commandErrors,
    200: { $ref: "CancelledReservation#", description: "Reserva cancelada; también repetición de una cancelación previamente completada." },
    409: {
      description: "La representación completa identifica la reserva en conflicto y su estado actual, además de code.",
      oneOf: [
        reservationConflictSchema("RESERVATION_EXPIRED", "EXPIRED", "La reserva venció; su cierre puede quedar comprometido con esta respuesta."),
        reservationConflictSchema("RESERVATION_STATE_CONFLICT", "OFFERED", "Esta operación no cancela ofertas ni las cierra por caducidad."),
        reservationConflictSchema("RESERVATION_STATE_CONFLICT", "CANCELLED", "La reserva terminó por rechazo o retirada, no por una cancelación anterior."),
        reservationConflictSchema("APPOINTMENT_STARTED", "CONFIRMED", "La cita confirmada ya ha comenzado; la igualdad con startsAt ya impide una cancelación nueva."),
      ],
    },
  },
};

export const reservationEvaluationSchema = {
  $id: "ReservationEvaluation", ...reservationShape,
  required: [...reservationShape.required, "evaluatedAt", "temporal", "actions"],
  properties: {
    ...reservationProperties, evaluatedAt: utcInstantSchema,
    temporal: {
      type: "object", required: ["expired", "closurePending"], additionalProperties: false,
      properties: {
        expired: { type: "boolean", description: "Solo HELD y OFFERED pueden estar vencidas al evaluar el plazo o el inicio." },
        closurePending: { type: "boolean", description: "La temporal ya venció pero el cierre aún no se ha persistido." },
      },
    },
    actions: {
      type: "object", required: ["canConfirm", "canCancel", "canRejectOffer"], additionalProperties: false,
      properties: {
        canConfirm: { type: "boolean", description: "Temporal vigente o CONFIRMED, también después del inicio." },
        canCancel: { type: "boolean", description: "HELD vigente o CONFIRMED antes del inicio; no autoriza cancelar una oferta." },
        canRejectOffer: { type: "boolean", description: "Solo OFFERED vigente." },
      },
    },
  },
  examples: [
    { ...heldExample, evaluatedAt: "2030-01-01T09:05:00.000Z", temporal: { expired: false, closurePending: false }, actions: { canConfirm: true, canCancel: true, canRejectOffer: false } },
    { ...heldExample, evaluatedAt: "2030-01-01T09:10:00.000Z", temporal: { expired: true, closurePending: true }, actions: { canConfirm: false, canCancel: false, canRejectOffer: false } },
    { ...heldExample, state: "CONFIRMED", evaluatedAt: "2030-01-01T09:10:00.000Z", temporal: { expired: false, closurePending: false }, actions: { canConfirm: true, canCancel: true, canRejectOffer: false } },
  ],
};

export const getReservationSchema: FastifySchema = {
  operationId: "getReservation", tags: ["Reservas"], summary: "Consultar el estado actual de una reserva propia",
  description: "Sin cuerpo. X-Patient-Id es una identidad sintética falsificable, no autenticación. Para un paciente registrado, un recurso ajeno o inexistente devuelve el mismo NOT_FOUND. Fotografía actual de estado persistido y acciones en evaluatedAt: no escribe ni normaliza caducidades. HELD u OFFERED pueden seguir persistidas tras vencer, con temporal.expired y closurePending verdaderos; la igualdad con expiresAt o startsAt ya vence. expiresAt conserva el plazo original y una CONFIRMED nunca se considera vencida por él. canConfirm admite temporal vigente o CONFIRMED; canCancel admite HELD vigente o CONFIRMED antes del inicio; canRejectOffer solo OFFERED vigente. CANCELLED y EXPIRED no permiten acciones. Las decisiones revalidan tiempo y estado al ejecutarse; consultar no amplía plazos. Este GET refleja el estado actual, mientras crear de nuevo con la misma clave devuelve el éxito histórico.",
  params: idParams, headers: patientHeaders,
  response: { ...readErrors, 200: { $ref: "ReservationEvaluation#", description: "Reserva persistida junto con evaluación temporal y acciones; sin datos privados del paciente." } },
};

export const holdSchema: FastifySchema = {
  operationId: "createHold", tags: ["Reservas"], summary: "Bloquear temporalmente un hueco",
  description: "Sin cuerpo. Crea una reserva HELD para X-Patient-Id. expiresAt es el menor de createdAt + TTL (10 minutos por defecto) y startsAt. La igualdad ya significa vencimiento; el tiempo y la ocupación se revalidan al decidir. Requiere Idempotency-Key: con la misma identidad, operación, clave y hueco recupera cuerpo y código 201 exitosos originales, incluso si la reserva cambió o terminó. Es un replay histórico, frente al estado actual de GET /reservations/{id}; ni repetir ni consultar amplía el plazo. Claves independientes por paciente y operación; los errores no se guardan como éxitos. No admite un hueco ocupado, iniciado o con espera elegible prioritaria.",
  params: idParams, headers: creationHeaders,
  response: {
    ...commandErrors,
    201: { $ref: "HeldReservation#", description: "Bloqueo creado o replay histórico del éxito original; conserva identidad, fechas y código 201." },
    404: codeErrorSchema("NOT_FOUND", "El hueco no existe; se comprueba después de validar al paciente y recuperar un éxito previo de la clave."),
    409: {
      description: "Clave reutilizada con otro hueco, hueco iniciado, ocupado o prioridad de la lista de espera.",
      oneOf: [
        codeErrorSchema("IDEMPOTENCY_KEY_REUSED", "La clave ya identifica un éxito para otro hueco."),
        codeErrorSchema("SLOT_STARTED", "El hueco ya ha comenzado."),
        codeErrorSchema("SLOT_OCCUPIED", "Una reserva persistida ocupa el hueco, incluso si su cierre por caducidad está pendiente."),
        codeErrorSchema("WAITING_LIST_PRIORITY", "Existe espera elegible con prioridad para el hueco."),
      ],
    },
  },
};
