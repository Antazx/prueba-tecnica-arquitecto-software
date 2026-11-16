import { randomUUID } from "node:crypto";
import { decideDirectHold, evaluateReservation } from "../domain/reservation.ts";
import type { Reservation, ReservationRepresentation, Scheduling } from "./scheduling.ts";

function represent(reservation: Reservation): ReservationRepresentation {
  return {
    id: reservation.id, slotId: reservation.slotId, state: reservation.state,
    createdAt: new Date(reservation.createdAt).toISOString(),
    expiresAt: new Date(reservation.expiresAt).toISOString(),
    startsAt: new Date(reservation.startsAt).toISOString(),
    endsAt: new Date(reservation.endsAt).toISOString(),
  };
}

export function schedulingUseCases(scheduling: Scheduling) {
  return {
    async createHold(patientId: string, slotId: string, key: string) {
      const identity = { patientId, operation: "create-hold", key };
      // There is no request body: the normalized destination is the entire intention.
      const fingerprint = JSON.stringify({ slotId });
      return scheduling.transaction(async (transaction) => {
        if (!await transaction.patientExists(patientId)) return { status: 400, body: { code: "UNKNOWN_PATIENT" } };
        const previous = await transaction.coordinateCreation(identity);
        if (previous) {
          if (previous.fingerprint !== fingerprint) return { status: 409, body: { code: "IDEMPOTENCY_KEY_REUSED" } };
          return { status: previous.status, body: previous.body };
        }
        const slot = await transaction.lockSlotForHold(slotId);
        if (!slot) return { status: 404, body: { code: "NOT_FOUND" } };
        const decision = decideDirectHold(slot, await transaction.currentTime());
        if (!decision.allowed) return { status: 409, body: { code: decision.code } };
        const reservation: Reservation = {
          id: randomUUID(), slotId, patientId, state: "HELD", createdAt: decision.createdAt,
          expiresAt: decision.expiresAt, startsAt: slot.startsAt, endsAt: slot.endsAt,
        };
        const body = represent(reservation);
        await transaction.insertDirectHold(reservation);
        await transaction.saveCreationResult(identity, { fingerprint, status: 201, body });
        return { status: 201, body };
      });
    },
    async getReservation(patientId: string, reservationId: string) {
      if (!await scheduling.patientExists(patientId)) return { status: 400, body: { code: "UNKNOWN_PATIENT" } };
      const snapshot = await scheduling.readOwnReservation(patientId, reservationId);
      if (!snapshot) return { status: 404, body: { code: "NOT_FOUND" } };
      const { reservation, evaluatedAt } = snapshot;
      const { expired, closurePending, ...actions } = evaluateReservation(reservation, evaluatedAt);
      return { status: 200, body: {
        ...represent(reservation), evaluatedAt: new Date(evaluatedAt).toISOString(),
        temporal: { expired, closurePending }, actions,
      } };
    },
  };
}

export type SchedulingUseCases = ReturnType<typeof schedulingUseCases>;
