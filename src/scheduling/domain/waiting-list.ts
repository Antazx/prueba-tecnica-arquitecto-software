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

export function decideWaitingWithdrawal(entry: { state: "WAITING" | "OFFERED" | "CLOSED"; closureReason?: "ACCEPTED" | "EXPIRED" | "WITHDRAWN" }) {
  if (entry.state === "CLOSED") return { allowed: true, state: entry.state, closureReason: entry.closureReason };
  if (entry.state === "OFFERED") return { allowed: false, state: entry.state, closureReason: entry.closureReason };
  return { allowed: true, state: "CLOSED" as const, closureReason: "WITHDRAWN" as const };
}

export function waitingListHasPriority(entries: readonly { state: string; excludedSlotIds: readonly string[] }[], slotId: string): boolean {
  return entries.some((entry) => entry.state === "WAITING" && !entry.excludedSlotIds.includes(slotId));
}
