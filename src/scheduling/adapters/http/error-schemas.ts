export function codeErrorSchema(code: string, description: string) {
  return {
    description, type: "object", required: ["code"], additionalProperties: false,
    properties: { code: { type: "string", const: code } }, examples: [{ code }],
  };
}

export const invalidRequestSchema = codeErrorSchema("INVALID_REQUEST", "Petición inválida: faltan campos obligatorios, hay campos adicionales, tipos incorrectos o contenido HTTP no permitido.");
export const dependencyUnavailableSchema = codeErrorSchema("DEPENDENCY_UNAVAILABLE", "El almacenamiento de citación no está disponible temporalmente.");
export const internalErrorSchema = codeErrorSchema("INTERNAL_ERROR", "Fallo interno inesperado; no se devuelven detalles técnicos ni datos de pacientes.");
