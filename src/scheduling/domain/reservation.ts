export type HoldDecision =
  | { allowed: true; createdAt: number; expiresAt: number }
  | { allowed: false; code: "SLOT_STARTED" | "SLOT_OCCUPIED" };

export function decideDirectHold(slot: { startsAt: number; occupied: boolean }, evaluatedAt: number): HoldDecision {
  const createdAt = Math.floor(evaluatedAt);
  const startsAt = Math.floor(slot.startsAt);
  if (createdAt >= startsAt) return { allowed: false, code: "SLOT_STARTED" };
  if (slot.occupied) return { allowed: false, code: "SLOT_OCCUPIED" };
  return { allowed: true, createdAt, expiresAt: Math.min(createdAt + 600_000, startsAt) };
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
