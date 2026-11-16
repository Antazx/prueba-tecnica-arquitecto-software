import { randomUUID } from "node:crypto";
import { offerDeadline, selectOffers } from "../domain/offers.ts";
import { evaluateReservation } from "../domain/reservation.ts";
import type { Scheduling } from "./scheduling.ts";

export interface Delivery {
  version: 1; publicationId: string; eventId: string; consumer: "allocation" | "notification"; cycle: number; attempt: number;
}
export interface LogicalEvent { type: string; version: number; payload: Record<string, string> }
export interface OfferNotification {
  event: "offer_notification"; eventId: string; reservationId: string; slotId: string; patientId: string; expiresAt: string;
}
export type NotificationWriter = (notification: OfferNotification) => Promise<void>;

export function messageUseCases(scheduling: Scheduling, writeNotification: NotificationWriter, options: { offerMaximumMs?: number } = {}) {
  return {
    async allocate(delivery: Delivery) {
      if (delivery.consumer !== "allocation") throw new Error("Unexpected allocation consumer");
      return scheduling.transaction(async (transaction) => {
        const event = await transaction.coordinateConsumption(delivery);
        if (!event) return;
        if (event.version !== 1 || !["SlotReleased", "AllocationReviewRequested"].includes(event.type)) throw new Error("Unsupported allocation event");
        const scope = { hospitalId: event.payload.hospitalId, testTypeId: event.payload.testTypeId };
        if (!await transaction.lockWaitingListScope(scope)) throw new Error("Unknown allocation scope");
        const state = await transaction.lockAdmissionState(scope);
        const time = await transaction.currentTime();
        for (const reservation of state.reservations) {
          if (!evaluateReservation(reservation, time).expired) continue;
          // Include started offers: their entry cannot remain indefinitely occupied.
          if (reservation.startsAt <= time && reservation.state !== "OFFERED") continue;
          await transaction.setReservationState(reservation.id, "EXPIRED");
          await transaction.recordSlotRelease(reservation, "EXPIRED", time);
          reservation.state = "EXPIRED";
          if (reservation.waitingListEntryId) {
            await transaction.closeWaitingListEntry(reservation.waitingListEntryId, "EXPIRED");
            const entry = state.entries.find((entry) => entry.id === reservation.waitingListEntryId);
            if (entry) entry.state = "CLOSED";
          }
        }
        const freeSlots = state.slots.filter((slot) => !state.reservations.some((reservation) =>
          reservation.slotId === slot.id && ["HELD", "OFFERED", "CONFIRMED"].includes(reservation.state)));
        for (const choice of selectOffers(freeSlots, state.entries, time)) {
          const slot = freeSlots.find((slot) => slot.id === choice.slotId)!;
          const entry = state.entries.find((entry) => entry.id === choice.entryId)!;
          const expiresAt = offerDeadline(slot.startsAt, time, options.offerMaximumMs);
          if (expiresAt === null) continue;
          await transaction.insertOffer({ id: randomUUID(), patientId: entry.patientId, slotId: slot.id,
            waitingListEntryId: entry.id, state: "OFFERED", createdAt: time, expiresAt,
            startsAt: slot.startsAt, endsAt: slot.endsAt }, scope);
        }
        await transaction.completeConsumption(delivery, "succeeded", time);
      });
    },
    async notify(delivery: Delivery) {
      if (delivery.consumer !== "notification") throw new Error("Unexpected notification consumer");
      return scheduling.transaction(async (transaction) => {
        const event = await transaction.coordinateConsumption(delivery);
        if (!event) return;
        if (event.version !== 1 || event.type !== "OfferCreated") throw new Error("Unsupported notification event");
        // Only the technical event/consumer lock is held across external output.
        const notification = await transaction.readOfferNotification(event.payload.reservationId, delivery.eventId);
        if (notification) await writeNotification(notification);
        await transaction.completeConsumption(delivery, notification ? "succeeded" : "discarded", await transaction.currentTime());
      });
    },
  };
}
