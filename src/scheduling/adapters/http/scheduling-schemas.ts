import { codeErrorSchema, invalidRequestSchema, internalErrorSchema, dependencyUnavailableSchema } from "./error-schemas.ts";

export const identifierSchema = { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" };
export const patientHeaders = {
  type: "object", required: ["x-patient-id"],
  properties: {
    "x-patient-id": { ...identifierSchema, description: "Identidad sintética presentada mediante X-Patient-Id: falsificable, no es autenticación real. Debe corresponder a un paciente de la demo.", examples: ["patient-ana"] },
  },
};
export const creationHeaders = {
  ...patientHeaders, required: ["x-patient-id", "idempotency-key"],
  properties: {
    ...patientHeaders.properties,
    "idempotency-key": { type: "string", minLength: 1, maxLength: 200, pattern: "^[!-~]+$", description: "Idempotency-Key: ASCII visible sin espacios. Independiente por paciente y operación. Misma clave y destino recuperan el cuerpo y código exitosos originales; un destino incompatible devuelve IDEMPOTENCY_KEY_REUSED. Los errores no guardan un éxito y permiten reevaluar la misma clave.", examples: ["demo-hold-1"] },
  },
};
export const idParams = { type: "object", required: ["id"], properties: { id: identifierSchema }, additionalProperties: false };
export const utcInstantSchema = { type: "string", format: "date-time", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" };

export const unknownPatientSchema = codeErrorSchema("UNKNOWN_PATIENT", "La identidad presentada es válida sintácticamente pero no corresponde a un paciente de la demo; se comprueba antes de buscar el recurso.");
export const bodyNotAllowedSchema = codeErrorSchema("BODY_NOT_ALLOWED", "La operación no admite cuerpo, incluido un objeto JSON vacío.");
export const notFoundSchema = codeErrorSchema("NOT_FOUND", "Recurso inexistente o ajeno: ambos casos devuelven el mismo 404, sin revelar su existencia.");
export const readErrors = {
  400: { description: "Entrada HTTP inválida o paciente desconocido.", oneOf: [invalidRequestSchema, unknownPatientSchema] },
  404: notFoundSchema, 500: internalErrorSchema, 503: dependencyUnavailableSchema,
};
export const commandErrors = {
  ...readErrors,
  400: { description: "Entrada HTTP inválida, paciente desconocido o cuerpo no permitido.", oneOf: [invalidRequestSchema, unknownPatientSchema, bodyNotAllowedSchema] },
};
