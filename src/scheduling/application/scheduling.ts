import type { WaitingListEntry, WaitingListRepresentation, WaitingListScope, AdmissionState } from "./waiting-list.ts";
import type { ReservationClosureReason, ReservationState } from "../domain/reservation.ts";
import type { Delivery, LogicalEvent, OfferNotification } from "./messages.ts";
import type { FailurePlan } from "../domain/message-retries.ts";

export interface Reservation {
  id: string;
  slotId: string;
  patientId: string;
  waitingListEntryId?: string;
  state: ReservationState;
  closureReason?: ReservationClosureReason;
  createdAt: number;
  expiresAt: number;
  startsAt: number;
  endsAt: number;
}

export interface ReservationRepresentation {
  id: string;
  slotId: string;
  state: ReservationState;
  createdAt: string;
  expiresAt: string;
  startsAt: string;
  endsAt: string;
}

export interface CreationIdentity { patientId: string; operation: string; key: string }
export interface CreationResult { fingerprint: string; status: 200 | 201; body: ReservationRepresentation | WaitingListRepresentation }
export interface ProtectedSlot { id: string; startsAt: number; endsAt: number; occupied: boolean; waitingPriority?: boolean }

// All methods in this callback share one transaction. No driver object crosses this boundary.
export interface SchedulingTransaction {
  coordinateConsumption(delivery: Delivery): Promise<LogicalEvent | null>;
  completeConsumption(delivery: Delivery, outcome: "succeeded" | "discarded", time: number): Promise<void>;
  failConsumption(delivery: Delivery, error: string, permanent: boolean, plan: FailurePlan, time: number): Promise<void>;
  readOfferNotification(reservationId: string, eventId: string): Promise<OfferNotification | null>;
  insertOffer(reservation: Reservation & { waitingListEntryId: string }, scope: WaitingListScope): Promise<void>;
  lockWaitingListScope(scope: WaitingListScope): Promise<boolean>;
  lockOwnWaitingListEntry(patientId: string, entryId: string): Promise<WaitingListEntry | null>;
  closeWaitingListEntry(entryId: string, reason: NonNullable<WaitingListEntry["closureReason"]>): Promise<void>;
  returnEntryAfterRejection(entryId: string, slotId: string): Promise<void>;
  lockAdmissionState(scope: WaitingListScope): Promise<AdmissionState>;
  insertWaitingListEntry(id: string, patientId: string, scope: WaitingListScope, createdAt: number): Promise<WaitingListEntry>;
  recordAllocationReview(scope: WaitingListScope, entryId: string, occurredAt: number): Promise<void>;
  patientExists(patientId: string): Promise<boolean>;
  coordinateCreation(identity: CreationIdentity): Promise<CreationResult | null>;
  lockSlotForHold(slotId: string): Promise<ProtectedSlot | null>;
  lockOwnReservation(patientId: string, reservationId: string): Promise<Reservation | null>;
  setReservationState(reservationId: string, state: ReservationState): Promise<void>;
  recordSlotRelease(reservation: Reservation, reason: ReservationClosureReason, occurredAt: number): Promise<void>;
  currentTime(): Promise<number>;
  insertDirectHold(reservation: Reservation): Promise<void>;
  saveCreationResult(identity: CreationIdentity, result: CreationResult): Promise<void>;
}

export interface Scheduling {
  transaction<T>(work: (transaction: SchedulingTransaction) => Promise<T>): Promise<T>;
  readOwnWaitingListEntry(patientId: string, entryId: string): Promise<{ entry: WaitingListEntry; evaluatedAt: number } | null>;
  dueTemporaryReservations(): Promise<{ id: string; patientId: string }[]>;
  patientExists(patientId: string): Promise<boolean>;
  readOwnReservation(patientId: string, reservationId: string): Promise<{ reservation: Reservation; evaluatedAt: number } | null>;
}

export class DependencyUnavailable extends Error {
  readonly scope: "global" | "operation";
  constructor(cause: unknown, scope: "global" | "operation" = "global") {
    super("Scheduling storage is temporarily unavailable", { cause });
    this.scope = scope;
  }
}
