import { waitingListUseCases } from "./waiting-list.ts";
import { offerDecisionUseCases } from "./offer-decisions.ts";
import { randomUUID } from "node:crypto";
import { decideDirectHold, evaluateReservation, decideConfirmation, decideCancellation } from "../domain/reservation.ts";
import type { Reservation, Scheduling } from "./scheduling.ts";
import { representReservation as represent } from "./reservation-representation.ts";
import { expireReservation } from "./reservation-expiry.ts";

export function schedulingUseCases(scheduling: Scheduling, options: { holdTtlMs?: number } = {}) {
  return {
    ...waitingListUseCases(scheduling),
    ...offerDecisionUseCases(scheduling),
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
        const decision = decideDirectHold(slot, await transaction.currentTime(), options.holdTtlMs);
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
    async confirmReservation(patientId: string, reservationId: string) {
      return scheduling.transaction(async (transaction) => {
        if (!await transaction.patientExists(patientId)) return { status: 400, body: { code: "UNKNOWN_PATIENT" } };
        const reservation = await transaction.lockOwnReservation(patientId, reservationId);
        if (!reservation) return { status: 404, body: { code: "NOT_FOUND" } };
        const evaluatedAt = await transaction.currentTime();
        const decision = decideConfirmation(reservation, evaluatedAt);
        if (decision.state !== reservation.state) {
          if (decision.state === "EXPIRED") await expireReservation(transaction, reservation, evaluatedAt);
          else {
            await transaction.setReservationState(reservation.id, decision.state);
            if (reservation.waitingListEntryId) await transaction.closeWaitingListEntry(reservation.waitingListEntryId, "ACCEPTED");
          }
        }
        const body = represent({ ...reservation, state: decision.state });
        return { status: decision.allowed ? 200 : 409, body: decision.allowed ? body : { ...body, code: decision.code } };
      });
    },
    async cancelReservation(patientId: string, reservationId: string) {
      return scheduling.transaction(async (transaction) => {
        if (!await transaction.patientExists(patientId)) return { status: 400, body: { code: "UNKNOWN_PATIENT" } };
        const reservation = await transaction.lockOwnReservation(patientId, reservationId);
        if (!reservation) return { status: 404, body: { code: "NOT_FOUND" } };
        const evaluatedAt = await transaction.currentTime();
        const decision = decideCancellation(reservation, evaluatedAt);
        if (decision.state !== reservation.state) {
          await transaction.setReservationState(reservation.id, decision.state);
          await transaction.recordSlotRelease(reservation, decision.state === "EXPIRED" ? "EXPIRED" : "CANCELLED", evaluatedAt);
        }
        const body = represent({ ...reservation, state: decision.state });
        return { status: decision.allowed ? 200 : 409, body: decision.allowed ? body : { ...body, code: decision.code } };
      });
    },
    async expireTemporaryReservations() {
      let expiredCount = 0;
      for (const candidate of await scheduling.dueTemporaryReservations()) {
        const expired = await scheduling.transaction(async (transaction) => {
          const reservation = await transaction.lockOwnReservation(candidate.patientId, candidate.id);
          if (!reservation || !["HELD", "OFFERED"].includes(reservation.state)) return false;
          const evaluatedAt = await transaction.currentTime();
          if (!evaluateReservation(reservation, evaluatedAt).expired) return false;
          await expireReservation(transaction, reservation, evaluatedAt);
          return true;
        });
        if (expired) expiredCount++;
      }
      return expiredCount;
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
