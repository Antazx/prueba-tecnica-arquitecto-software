import { decideOfferRejection } from "../domain/offers.ts";
import type { Scheduling } from "./scheduling.ts";
import { representReservation } from "./reservation-representation.ts";

export function offerDecisionUseCases(scheduling: Scheduling) {
  return {
    async rejectOffer(patientId: string, reservationId: string) {
      return scheduling.transaction(async (transaction) => {
        if (!await transaction.patientExists(patientId)) return { status: 400, body: { code: "UNKNOWN_PATIENT" } };
        const reservation = await transaction.lockOwnReservation(patientId, reservationId);
        if (!reservation) return { status: 404, body: { code: "NOT_FOUND" } };
        const time = await transaction.currentTime();
        const decision = decideOfferRejection(reservation, time);
        if (decision.state !== reservation.state) {
          await transaction.setReservationState(reservation.id, decision.state);
          if (!reservation.waitingListEntryId || !decision.reason) throw new Error("Offer must belong to a waiting list entry");
          if (decision.returnToWaiting) await transaction.returnEntryAfterRejection(reservation.waitingListEntryId, reservation.slotId);
          else await transaction.closeWaitingListEntry(reservation.waitingListEntryId, "EXPIRED");
          // This release alone activates the complete scope, including other free slots.
          await transaction.recordSlotRelease(reservation, decision.reason, time);
        }
        const body = representReservation({ ...reservation, state: decision.state });
        return { status: decision.allowed ? 200 : 409, body: decision.allowed ? body : { ...body, code: decision.code } };
      });
    },
  };
}
