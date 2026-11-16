import type { FastifySchema } from "fastify";
import { codeErrorSchema } from "./error-schemas.ts";
import { reservationConflictSchema } from "./reservation-schemas.ts";
import { commandErrors, creationHeaders, identifierSchema, idParams, patientHeaders, readErrors, utcInstantSchema } from "./scheduling-schemas.ts";

export const rejectOfferSchema: FastifySchema = {
  operationId: "rejectOffer", tags: ["Lista de espera"], summary: "Rechazar una oferta propia conservando antigüedad",
  description: "Sin cuerpo ni Idempotency-Key obligatoria. Rechazar OFFERED vigente devuelve la reserva CANCELLED, excluye ese hueco para la inscripción y la devuelve a WAITING conservando su antigüedad FIFO. La liberación activa asíncronamente todo el ámbito, incluidos otros huecos libres. Repetir un rechazo válido conserva 200 incluso tras el plazo o una oferta posterior, sin alterarla. Al vencer la oferta (incluida igualdad con expiresAt o startsAt), cierra reserva e inscripción por EXPIRED y devuelve 409 RESERVATION_EXPIRED, conservando la representación completa de reserva. HELD, CONFIRMED y CANCELLED por otra causa producen RESERVATION_STATE_CONFLICT; HELD vencido sigue siendo conflicto de estado y no se cierra con esta operación. El aviso comunica una oferta ya creada, puede llegar tarde y no garantiza vigencia ni recepción humana. El plazo es el menor de creación más OFFER_MAXIMUM_MS (dos horas por defecto) e inicio del hueco. Estado y plazo se revalidan tras esperar; no se amplían. Identidad sintética falsificable; recurso ajeno e inexistente comparten NOT_FOUND.",
  params: idParams, headers: patientHeaders,
  response: {
    ...commandErrors,
    200: { $ref: "CancelledReservation#", description: "Oferta rechazada o repetición de un rechazo válido; conserva la identidad de la reserva." },
    409: {
      description: "Reserva completa con estado actual y code; un vencimiento puede comprometer el cierre y liberación con este conflicto.",
      oneOf: [
        reservationConflictSchema("RESERVATION_EXPIRED", "EXPIRED", "Oferta vencida o reserva ya caducada."),
        ...["HELD", "CONFIRMED", "CANCELLED"].map((state) => reservationConflictSchema("RESERVATION_STATE_CONFLICT", state, "La reserva no es una oferta vigente ni un rechazo válido previo.")),
      ],
    },
  },
};

const entryProperties = {
  id: { type: "string", format: "uuid" },
  hospitalId: identifierSchema, testTypeId: identifierSchema,
  admissionOrder: { type: "string", pattern: "^[1-9][0-9]*$", description: "Antigüedad FIFO persistida como entero decimal positivo, representado como string para conservar precisión." },
  state: { type: "string", enum: ["WAITING", "OFFERED", "CLOSED"] },
  createdAt: utcInstantSchema,
  excludedSlotIds: { type: "array", items: { type: "string" }, description: "Huecos rechazados por esta inscripción; no excluye otros huecos del ámbito." },
};
const entryShape = { type: "object", required: Object.keys(entryProperties), additionalProperties: false, properties: entryProperties };
const closureReasonSchema = { type: "string", enum: ["ACCEPTED", "EXPIRED", "WITHDRAWN"] };
// The application includes an undefined closureReason on active entries; JSON omits it.
const waitingShape = { ...entryShape, properties: { ...entryProperties, state: { type: "string", const: "WAITING" }, closureReason: closureReasonSchema } };
const offeredShape = {
  ...entryShape, required: [...entryShape.required, "offer"],
  properties: { ...entryProperties, state: { type: "string", const: "OFFERED" }, closureReason: closureReasonSchema, offer: {
    allOf: [{ $ref: "Reservation#" }, { type: "object", properties: { state: { type: "string", const: "OFFERED" } } }],
    description: "Reserva temporal exclusiva, con identidad y plazo propios; existe antes de su aviso asíncrono.",
  } },
};
const closedShape = {
  ...entryShape, required: [...entryShape.required, "closureReason"],
  properties: { ...entryProperties, state: { type: "string", const: "CLOSED" }, closureReason: closureReasonSchema },
};
const waitingExample = {
  id: "20000000-0000-4000-8000-000000000001", hospitalId: "hospital-south", testTypeId: "mri",
  admissionOrder: "1", state: "WAITING", createdAt: "2030-01-01T09:00:00.000Z", excludedSlotIds: [],
};
const offeredExample = {
  ...waitingExample, state: "OFFERED", offer: {
    id: "10000000-0000-4000-8000-000000000002", slotId: "slot-south-mri-1", state: "OFFERED",
    createdAt: "2030-01-01T09:05:00.000Z", expiresAt: "2030-01-01T11:05:00.000Z",
    startsAt: "2030-01-02T09:00:00.000Z", endsAt: "2030-01-02T09:30:00.000Z",
  },
};
export const newWaitingListEntrySchema = { $id: "NewWaitingListEntry", ...waitingShape, examples: [waitingExample] };
export const activeWaitingListEntrySchema = { $id: "ActiveWaitingListEntry", oneOf: [waitingShape, offeredShape], examples: [waitingExample, offeredExample] };
export const closedWaitingListEntrySchema = {
  $id: "ClosedWaitingListEntry", ...closedShape,
  examples: ["ACCEPTED", "EXPIRED", "WITHDRAWN"].map((closureReason) => ({ ...waitingExample, state: "CLOSED", closureReason })),
};

export const withdrawWaitingListEntrySchema: FastifySchema = {
  operationId: "withdrawWaitingListEntry", tags: ["Lista de espera"], summary: "Retirar una inscripción propia o consultar su cierre previo",
  description: "Sin cuerpo ni Idempotency-Key obligatoria. WAITING se cierra por WITHDRAWN. OFFERED vigente cancela su oferta y cierra la inscripción atómicamente; la liberación se comunica por mensajería asíncrona. Una retirada tardía devuelve 200 CLOSED/EXPIRED, incluso si la oferta seguía persistida pendiente de cierre. La igualdad con el plazo ya vence. Repetir conserva la causa real ACCEPTED, EXPIRED o WITHDRAWN, sin oferta en el cuerpo. Retirar una inscripción ACCEPTED no cancela la cita confirmada, y retirar un ID antiguo no altera una inscripción posterior. La evaluación actions del GET es informativa; esta decisión revalida estado y plazo tras esperar. Identidad sintética falsificable, sin autenticación real; recurso ajeno e inexistente comparten NOT_FOUND.",
  params: idParams, headers: patientHeaders,
  response: { ...commandErrors, 200: { $ref: "ClosedWaitingListEntry#", description: "Inscripción cerrada con su causa real; no incluye offer ni evaluación temporal." } },
};

const evaluationProperties = {
  evaluatedAt: utcInstantSchema,
  temporal: {
    type: "object", required: ["expired", "closurePending"], additionalProperties: false,
    properties: {
      expired: { type: "boolean", description: "Solo OFFERED puede tener su oferta vencida sin cierre persistido." },
      closurePending: { type: "boolean", description: "La oferta venció pero la inscripción sigue OFFERED hasta persistir el cierre." },
    },
  },
  actions: {
    type: "object", required: ["canWithdraw", "canAcceptOffer", "canRejectOffer"], additionalProperties: false,
    properties: {
      canWithdraw: { type: "boolean", description: "WAITING u OFFERED vigente. Una retirada tardía conserva la causa real de cierre." },
      canAcceptOffer: { type: "boolean", description: "Solo OFFERED vigente; se acepta mediante confirmación de offer.id." },
      canRejectOffer: { type: "boolean", description: "Solo OFFERED vigente." },
    },
  },
};
const noExpiry = { expired: false, closurePending: false };
const noActions = { canWithdraw: false, canAcceptOffer: false, canRejectOffer: false };
export const waitingListEntryEvaluationSchema = {
  $id: "WaitingListEntryEvaluation",
  oneOf: [waitingShape, offeredShape, closedShape].map((shape) => ({
    ...shape, required: [...shape.required, ...Object.keys(evaluationProperties)], properties: { ...shape.properties, ...evaluationProperties },
  })),
  examples: [
    { ...waitingExample, evaluatedAt: "2030-01-01T09:05:00.000Z", temporal: noExpiry, actions: { ...noActions, canWithdraw: true } },
    { ...offeredExample, evaluatedAt: "2030-01-01T09:10:00.000Z", temporal: noExpiry, actions: { canWithdraw: true, canAcceptOffer: true, canRejectOffer: true } },
    { ...offeredExample, evaluatedAt: "2030-01-01T11:05:00.000Z", temporal: { expired: true, closurePending: true }, actions: noActions },
    ...["ACCEPTED", "EXPIRED", "WITHDRAWN"].map((closureReason) => ({ ...waitingExample, state: "CLOSED", closureReason, evaluatedAt: "2030-01-01T11:10:00.000Z", temporal: noExpiry, actions: noActions })),
  ],
};

export const getWaitingListEntrySchema: FastifySchema = {
  operationId: "getWaitingListEntry", tags: ["Lista de espera"], summary: "Consultar una inscripción propia y su oferta actual",
  description: "Sin cuerpo. X-Patient-Id es sintético y falsificable; recurso ajeno e inexistente comparten NOT_FOUND. Fotografía de solo lectura en evaluatedAt: no escribe ni normaliza. WAITING no tiene oferta ni causa; OFFERED incluye offer; CLOSED incluye closureReason (ACCEPTED, EXPIRED o WITHDRAWN), sin oferta. No hay expiresAt en la inscripción. Una OFFERED vencida conserva estado y oferta persistidos, con temporal.expired y closurePending verdaderos y todas las acciones falsas; no vuelve a WAITING ni admite otra oferta. WAITING permite retirada; OFFERED vigente permite retirar, aceptar y rechazar; CLOSED no permite acciones. La oferta vence al menor de su creación más OFFER_MAXIMUM_MS (dos horas por defecto) e inicio del hueco; la igualdad ya vence. El aviso asíncrono comunica una oferta ya existente y no garantiza vigencia ni recepción humana; puede llegar tarde o no existir un aviso utilizable. Aceptar mediante POST /reservations/{id}/confirm sobre offer.id revalida estado y plazo y conserva la identidad de la reserva. Un replay de alta conserva el éxito histórico; este GET muestra el estado actual.",
  params: idParams, headers: patientHeaders,
  response: { ...readErrors, 200: { $ref: "WaitingListEntryEvaluation#", description: "Inscripción actual con evaluación temporal; los campos opcionales dependen del estado persistido." } },
};

const publicSlotProperties = { id: { type: "string" }, hospitalId: identifierSchema, testTypeId: identifierSchema, startsAt: utcInstantSchema, endsAt: utcInstantSchema };
const admissionConflictSchema = {
  description: "No crea inscripción ni guarda un éxito de alta. Puede conservar cierres por vencimiento y liberaciones ya comprometidos.",
  oneOf: [
    codeErrorSchema("IDEMPOTENCY_KEY_REUSED", "La clave exitosa se usó con otro ámbito para el mismo paciente y operación."),
    codeErrorSchema("ACTIVE_HOLD_IN_SCOPE", "Q24: existe un HELD propio vigente del mismo ámbito al decidir una admisión nueva."),
    {
      type: "object", required: ["code", "slots"], additionalProperties: false,
      properties: {
        code: { type: "string", const: "DIRECT_CAPACITY_AVAILABLE" },
        slots: { type: "array", minItems: 1, items: { type: "object", required: Object.keys(publicSlotProperties), additionalProperties: false, properties: publicSlotProperties } },
      },
      description: "Q2: capacidad directa disponible; contiene referencias públicas, sin paciente, reserva ni recurso diagnóstico.",
      examples: [{ code: "DIRECT_CAPACITY_AVAILABLE", slots: [{ id: "slot-south-mri-1", hospitalId: "hospital-south", testTypeId: "mri", startsAt: "2030-01-02T09:00:00.000Z", endsAt: "2030-01-02T09:30:00.000Z" }] }],
    },
  ],
};

export const joinWaitingListSchema: FastifySchema = {
  operationId: "joinWaitingList", tags: ["Lista de espera"], summary: "Inscribirse o recuperar una inscripción activa del ámbito",
  description: "Requiere cuerpo JSON, X-Patient-Id sintético falsificable e Idempotency-Key. La identidad se comprueba primero. Un éxito previo de la clave y el mismo ámbito recupera exactamente el cuerpo y código histórico 200/201, antes de comprobar estado o plazos; no amplía plazos. Un ámbito incompatible devuelve IDEMPOTENCY_KEY_REUSED. Sin éxito previo: valida el ámbito, normaliza temporales propias vencidas y recupera la inscripción activa con 200 (WAITING u OFFERED), antes de normalizar las demás pertinentes y decidir una admisión nueva con 201. Solo para esta admisión aplica Q24 ACTIVE_HOLD_IN_SCOPE antes de Q2 DIRECT_CAPACITY_AVAILABLE. Un rechazo no crea inscripción ni éxito de alta y puede conservar cierres y liberaciones ya comprometidos. No hay prohibición global de coexistir con un bloqueo: una inscripción activa o replay histórico preceden esas reglas. Las claves son independientes por paciente y operación; los errores permiten reevaluar la misma clave. La oferta se crea por mensajería asíncrona antes de su aviso; el aviso no garantiza vigencia ni recepción humana.",
  headers: creationHeaders,
  body: { type: "object", required: ["hospitalId", "testTypeId"], additionalProperties: false, properties: { hospitalId: identifierSchema, testTypeId: identifierSchema }, examples: [{ hospitalId: "hospital-south", testTypeId: "mri" }] },
  response: {
    ...readErrors,
    200: { $ref: "ActiveWaitingListEntry#", description: "Inscripción activa existente o replay histórico de un éxito 200; puede incluir una oferta." },
    201: { $ref: "NewWaitingListEntry#", description: "Inscripción nueva en espera o replay histórico de ese éxito 201." },
    409: admissionConflictSchema,
  },
};
