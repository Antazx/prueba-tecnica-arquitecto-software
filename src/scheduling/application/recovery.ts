import type { Delivery } from "./messages.ts";
import type { Scheduling } from "./scheduling.ts";

export interface RecoveryRequest {
  delivery: Delivery;
  source: "application_dlq" | "broker_dlq" | "persisted";
  operator: string;
  reason: string;
}
export interface RecoveryResult {
  outcome: "recovered" | "already_completed" | "superseded";
  cycle: number;
  publicationId: string | null;
}

export async function recoverMessage(scheduling: Scheduling, request: RecoveryRequest): Promise<RecoveryResult> {
  if (!request.operator.trim() || request.operator.length > 100 || !request.reason.trim() || request.reason.length > 1000) {
    throw new Error("Recovery requires an operator and a bounded reason");
  }
  return scheduling.transaction((transaction) => transaction.recoverConsumption(request));
}
