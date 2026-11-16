import type { Reservation, SchedulingTransaction } from "./scheduling.ts";

export async function expireReservation(transaction: SchedulingTransaction, reservation: Reservation, time: number) {
  await transaction.setReservationState(reservation.id, "EXPIRED");
  await transaction.recordSlotRelease(reservation, "EXPIRED", time);
  if (reservation.waitingListEntryId) await transaction.closeWaitingListEntry(reservation.waitingListEntryId, "EXPIRED");
}
