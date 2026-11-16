import type { ReservationState } from "../domain/reservation.ts";

export interface Reservation {
  id: string;
  slotId: string;
  patientId: string;
  state: ReservationState;
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
export interface CreationResult { fingerprint: string; status: 200 | 201; body: ReservationRepresentation }
export interface ProtectedSlot { id: string; startsAt: number; endsAt: number; occupied: boolean }

// All methods in this callback share one transaction. No driver object crosses this boundary.
export interface SchedulingTransaction {
  patientExists(patientId: string): Promise<boolean>;
  coordinateCreation(identity: CreationIdentity): Promise<CreationResult | null>;
  lockSlotForHold(slotId: string): Promise<ProtectedSlot | null>;
  currentTime(): Promise<number>;
  insertDirectHold(reservation: Reservation): Promise<void>;
  saveCreationResult(identity: CreationIdentity, result: CreationResult): Promise<void>;
}

export interface Scheduling {
  transaction<T>(work: (transaction: SchedulingTransaction) => Promise<T>): Promise<T>;
  patientExists(patientId: string): Promise<boolean>;
  readOwnReservation(patientId: string, reservationId: string): Promise<{ reservation: Reservation; evaluatedAt: number } | null>;
}

export class DependencyUnavailable extends Error {
  constructor(cause: unknown) { super("Scheduling storage is temporarily unavailable", { cause }); }
}
