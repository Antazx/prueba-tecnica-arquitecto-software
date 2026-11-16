import type { Reservation, ReservationRepresentation } from "./scheduling.ts";

export function representReservation(reservation: Reservation): ReservationRepresentation {
  return {
    id: reservation.id, slotId: reservation.slotId, state: reservation.state,
    createdAt: new Date(reservation.createdAt).toISOString(),
    expiresAt: new Date(reservation.expiresAt).toISOString(),
    startsAt: new Date(reservation.startsAt).toISOString(),
    endsAt: new Date(reservation.endsAt).toISOString(),
  };
}
