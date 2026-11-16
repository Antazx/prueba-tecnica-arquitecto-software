import { randomUUID } from "node:crypto";
import { decideAdmission, hasActiveDirectHold, decideWaitingWithdrawal, waitingListHasPriority } from "../domain/waiting-list.ts";
import { evaluateReservation } from "../domain/reservation.ts";
import { evaluateEntryOffer } from "../domain/offers.ts";
import type { Reservation, Scheduling, SchedulingTransaction } from "./scheduling.ts";
import { representReservation as represent } from "./reservation-representation.ts";
import { expireReservation } from "./reservation-expiry.ts";

export interface WaitingListScope { hospitalId: string; testTypeId: string }
export interface WaitingListEntry extends WaitingListScope {
  id: string; patientId: string; admissionOrder: string; state: "WAITING" | "OFFERED" | "CLOSED";
  closureReason?: "ACCEPTED" | "EXPIRED" | "WITHDRAWN"; createdAt: number; excludedSlotIds: string[];
  offer?: Reservation;
}
export interface AdmissionState {
  entries: WaitingListEntry[]; reservations: Reservation[];
  slots: { id: string; startsAt: number; endsAt: number }[];
}
export interface WaitingListRepresentation extends WaitingListScope {
  id: string; admissionOrder: string; state: WaitingListEntry["state"]; closureReason?: WaitingListEntry["closureReason"]; createdAt: string; excludedSlotIds: string[];
  offer?: ReturnType<typeof represent>;
}

export function representEntry(entry: WaitingListEntry): WaitingListRepresentation {
  return { id: entry.id, hospitalId: entry.hospitalId, testTypeId: entry.testTypeId,
    admissionOrder: entry.admissionOrder, state: entry.state, closureReason: entry.closureReason,
    createdAt: new Date(entry.createdAt).toISOString(), excludedSlotIds: entry.excludedSlotIds,
    ...(entry.offer ? { offer: represent(entry.offer) } : {}) };
}

async function expireAdmissionReservations(transaction: SchedulingTransaction, state: AdmissionState, time: number, pertinent: (reservation: Reservation) => boolean) {
  let released = false;
  for (const reservation of state.reservations) {
    if (!["HELD", "OFFERED"].includes(reservation.state) || !pertinent(reservation) || !evaluateReservation(reservation, time).expired) continue;
    await expireReservation(transaction, reservation, time);
    if (reservation.waitingListEntryId) {
      const entry = state.entries.find((entry) => entry.id === reservation.waitingListEntryId);
      if (entry) { entry.state = "CLOSED"; entry.closureReason = "EXPIRED"; }
    }
    reservation.state = "EXPIRED";
    released = true;
  }
  return released;
}

export function waitingListUseCases(scheduling: Scheduling) {
  return {
    async getWaitingListEntry(patientId: string, entryId: string) {
      if (!await scheduling.patientExists(patientId)) return { status: 400, body: { code: "UNKNOWN_PATIENT" } };
      const snapshot = await scheduling.readOwnWaitingListEntry(patientId, entryId);
      if (!snapshot) return { status: 404, body: { code: "NOT_FOUND" } };
      return { status: 200, body: { ...representEntry(snapshot.entry), evaluatedAt: new Date(snapshot.evaluatedAt).toISOString(),
        ...evaluateEntryOffer(snapshot.entry.state, snapshot.entry.offer, snapshot.evaluatedAt) } };
    },
    async withdrawWaitingListEntry(patientId: string, entryId: string) {
      return scheduling.transaction(async (transaction) => {
        if (!await transaction.patientExists(patientId)) return { status: 400, body: { code: "UNKNOWN_PATIENT" } };
        const entry = await transaction.lockOwnWaitingListEntry(patientId, entryId);
        if (!entry) return { status: 404, body: { code: "NOT_FOUND" } };
        const time = await transaction.currentTime();
        const decision = decideWaitingWithdrawal(entry, entry.offer, time);
        if (decision.state !== entry.state && decision.closureReason) {
          if (entry.offer && decision.reservationState) {
            await transaction.setReservationState(entry.offer.id, decision.reservationState);
            await transaction.recordSlotRelease(entry.offer, decision.closureReason === "EXPIRED" ? "EXPIRED" : "WITHDRAWN", time);
          }
          await transaction.closeWaitingListEntry(entry.id, decision.closureReason);
        }
        return { status: 200, body: representEntry({ ...entry, offer: undefined, state: decision.state, closureReason: decision.closureReason }) };
      });
    },
    async joinWaitingList(patientId: string, scope: WaitingListScope, key: string) {
      const identity = { patientId, operation: "join-waiting-list", key };
      const fingerprint = JSON.stringify({ hospitalId: scope.hospitalId, testTypeId: scope.testTypeId });
      return scheduling.transaction(async (transaction) => {
        if (!await transaction.patientExists(patientId)) return { status: 400, body: { code: "UNKNOWN_PATIENT" } };
        const previous = await transaction.coordinateCreation(identity);
        if (previous) return previous.fingerprint === fingerprint ? { status: previous.status, body: previous.body }
          : { status: 409, body: { code: "IDEMPOTENCY_KEY_REUSED" } };
        if (!await transaction.lockWaitingListScope(scope)) return { status: 404, body: { code: "NOT_FOUND" } };
        const state = await transaction.lockAdmissionState(scope);
        const createdAt = await transaction.currentTime();
        let released = await expireAdmissionReservations(transaction, state, createdAt, (reservation) => reservation.patientId === patientId);
        const active = state.entries.find((entry) => entry.patientId === patientId && entry.state !== "CLOSED");
        if (active) {
          active.offer = state.reservations.find((reservation) => reservation.waitingListEntryId === active.id && reservation.state === "OFFERED");
          const body = representEntry(active);
          await transaction.saveCreationResult(identity, { fingerprint, status: 200, body });
          return { status: 200, body };
        }
        released = await expireAdmissionReservations(transaction, state, createdAt, (reservation) => reservation.startsAt > createdAt) || released;
        const available = state.slots.filter((slot) => slot.startsAt > createdAt && !waitingListHasPriority(state.entries, slot.id) &&
          !state.reservations.some((reservation) => reservation.slotId === slot.id && ["HELD", "OFFERED", "CONFIRMED"].includes(reservation.state)));
        const decision = decideAdmission({ hasActiveEntry: false,
          hasOwnHold: hasActiveDirectHold(state.reservations.filter((reservation) => reservation.patientId === patientId), createdAt),
          hasDirectCapacity: available.length > 0 });
        if (decision.kind === "active-hold") return { status: 409, body: { code: "ACTIVE_HOLD_IN_SCOPE" } };
        if (decision.kind === "direct-capacity") return { status: 409, body: { code: "DIRECT_CAPACITY_AVAILABLE", slots: available.map((slot) => ({
          id: slot.id, ...scope, startsAt: new Date(slot.startsAt).toISOString(), endsAt: new Date(slot.endsAt).toISOString(),
        })) } };
        const entry = await transaction.insertWaitingListEntry(randomUUID(), patientId, scope, createdAt);
        if (!released) await transaction.recordAllocationReview(scope, entry.id, createdAt);
        const body = representEntry(entry);
        await transaction.saveCreationResult(identity, { fingerprint, status: 201, body });
        return { status: 201, body };
      });
    },
  };
}
