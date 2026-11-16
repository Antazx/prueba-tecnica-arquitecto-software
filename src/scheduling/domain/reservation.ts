export type HoldDecision =
  | { allowed: true; createdAt: number; expiresAt: number }
  | { allowed: false; code: "SLOT_STARTED" | "SLOT_OCCUPIED" | "WAITING_LIST_PRIORITY" };

export function decideDirectHold(slot: { startsAt: number; occupied: boolean; waitingPriority?: boolean }, evaluatedAt: number, holdTtlMs = 600_000): HoldDecision {
  if (!Number.isInteger(holdTtlMs) || holdTtlMs < 1 || holdTtlMs > 600_000) throw new Error("Hold TTL must be an integer between 1 and 600000 milliseconds");
  const createdAt = Math.floor(evaluatedAt);
  const startsAt = Math.floor(slot.startsAt);
  if (createdAt >= startsAt) return { allowed: false, code: "SLOT_STARTED" };
  if (slot.occupied) return { allowed: false, code: "SLOT_OCCUPIED" };
  if (slot.waitingPriority) return { allowed: false, code: "WAITING_LIST_PRIORITY" };
  return { allowed: true, createdAt, expiresAt: Math.min(createdAt + holdTtlMs, startsAt) };
}

export type ReservationState = "HELD" | "OFFERED" | "CONFIRMED" | "CANCELLED" | "EXPIRED";

export function evaluateReservation(reservation: { state: ReservationState; expiresAt: number; startsAt: number }, time: number) {
  const temporary = reservation.state === "HELD" || reservation.state === "OFFERED";
  const expired = temporary && Math.floor(time) >= Math.floor(reservation.expiresAt);
  return {
    expired,
    closurePending: expired,
    canConfirm: reservation.state === "CONFIRMED" || (temporary && !expired),
    canCancel: (reservation.state === "HELD" && !expired) ||
      (reservation.state === "CONFIRMED" && Math.floor(time) < Math.floor(reservation.startsAt)),
    canRejectOffer: reservation.state === "OFFERED" && !expired,
  };
}

export type ReservationDecision =
  | { allowed: true; state: ReservationState }
  | { allowed: false; state: ReservationState; code: "RESERVATION_STATE_CONFLICT" | "RESERVATION_EXPIRED" | "APPOINTMENT_STARTED" };

export function decideConfirmation(reservation: { state: ReservationState; expiresAt: number; startsAt: number }, time: number): ReservationDecision {
  if (reservation.state === "CONFIRMED") return { state: "CONFIRMED", allowed: true };
  if (reservation.state === "CANCELLED") return { state: "CANCELLED", allowed: false, code: "RESERVATION_STATE_CONFLICT" };
  if (reservation.state === "EXPIRED" || Math.floor(time) >= Math.floor(reservation.expiresAt)) return { state: "EXPIRED", allowed: false, code: "RESERVATION_EXPIRED" };
  return { state: "CONFIRMED", allowed: true };
}

export type ReservationClosureReason = "CANCELLED" | "EXPIRED" | "OFFER_REJECTED" | "WITHDRAWN";

export function decideCancellation(reservation: { state: ReservationState; expiresAt: number; startsAt: number; closureReason?: ReservationClosureReason }, time: number): ReservationDecision {
  if (reservation.state === "OFFERED") return { state: "OFFERED", allowed: false, code: "RESERVATION_STATE_CONFLICT" };
  if (reservation.state === "CANCELLED") return reservation.closureReason === "CANCELLED"
    ? { state: "CANCELLED", allowed: true }
    : { state: "CANCELLED", allowed: false, code: "RESERVATION_STATE_CONFLICT" };
  if (reservation.state === "EXPIRED") return { state: "EXPIRED", allowed: false, code: "RESERVATION_EXPIRED" };
  if (reservation.state === "CONFIRMED") return Math.floor(time) < Math.floor(reservation.startsAt)
    ? { state: "CANCELLED", allowed: true }
    : { state: "CONFIRMED", allowed: false, code: "APPOINTMENT_STARTED" };
  if (Math.floor(time) >= Math.floor(reservation.expiresAt)) return { state: "EXPIRED", allowed: false, code: "RESERVATION_EXPIRED" };
  return { state: "CANCELLED", allowed: true };
}
