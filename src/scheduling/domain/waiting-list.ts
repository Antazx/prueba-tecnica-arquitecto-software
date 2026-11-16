export function hasActiveDirectHold(reservations: readonly { state: string; expiresAt: number }[], time: number): boolean {
  return reservations.some((reservation) => reservation.state === "HELD" && Math.floor(time) < Math.floor(reservation.expiresAt));
}

export function decideAdmission(state: { hasActiveEntry: boolean; hasOwnHold: boolean; hasDirectCapacity: boolean }):
  { kind: "existing-entry" | "active-hold" | "direct-capacity" | "admit" } {
  if (state.hasActiveEntry) return { kind: "existing-entry" };
  if (state.hasOwnHold) return { kind: "active-hold" };
  if (state.hasDirectCapacity) return { kind: "direct-capacity" };
  return { kind: "admit" };
}

export function decideWaitingWithdrawal(entry: { state: "WAITING" | "OFFERED" | "CLOSED"; closureReason?: "ACCEPTED" | "EXPIRED" | "WITHDRAWN" }, offer: { expiresAt: number } | undefined, time: number) {
  if (entry.state === "CLOSED") return { state: entry.state, closureReason: entry.closureReason };
  if (entry.state === "OFFERED") {
    if (!offer) throw new Error("Offered entry must have an offer");
    return Math.floor(time) >= Math.floor(offer.expiresAt)
      ? { state: "CLOSED" as const, closureReason: "EXPIRED" as const, reservationState: "EXPIRED" as const }
      : { state: "CLOSED" as const, closureReason: "WITHDRAWN" as const, reservationState: "CANCELLED" as const };
  }
  return { state: "CLOSED" as const, closureReason: "WITHDRAWN" as const };
}

export function waitingListHasPriority(entries: readonly { state: string; excludedSlotIds: readonly string[] }[], slotId: string): boolean {
  return entries.some((entry) => entry.state === "WAITING" && !entry.excludedSlotIds.includes(slotId));
}
