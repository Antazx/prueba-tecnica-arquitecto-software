import { DependencyUnavailable } from "../../application/scheduling.ts";

export function storageError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const code = "code" in error ? String(error.code) : "";
  if (code.startsWith("08") || ["40001", "40P01", "55P03", "57014", "53300", "57P01", "57P02", "57P03",
    "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"].includes(code) ||
      ["Query read timeout", "Connection terminated unexpectedly", "timeout exceeded when trying to connect", "Connection terminated due to connection timeout"].includes(error.message)) {
    return new DependencyUnavailable(error, ["40001", "40P01", "55P03", "57014"].includes(code) ? "operation" : "global");
  }
  return error;
}
