import { evaluateReservation } from "./reservation.ts";

export function evaluateEntryOffer(state: "WAITING" | "OFFERED" | "CLOSED", offer: { expiresAt: number; startsAt: number } | undefined, time: number) {
  const evaluation = offer && state === "OFFERED" ? evaluateReservation({ ...offer, state: "OFFERED" }, time) : undefined;
  const expired = evaluation?.expired ?? false;
  return {
    temporal: { expired, closurePending: expired },
    actions: { canWithdraw: state !== "CLOSED" && !expired, canAcceptOffer: Boolean(evaluation && !expired), canRejectOffer: Boolean(evaluation && !expired) },
  };
}

export function offerDeadline(startsAt: number, createdAt: number, maximumMs = 7_200_000): number | null {
  if (!Number.isSafeInteger(maximumMs) || maximumMs < 1) throw new Error("Offer maximum must be a positive integer in milliseconds");
  const time = Math.floor(createdAt);
  return time < Math.floor(startsAt) ? Math.min(time + maximumMs, Math.floor(startsAt)) : null;
}

export function selectOffers(
  freeSlots: readonly { id: string; startsAt: number }[],
  entries: readonly { id: string; state: string; admissionOrder: string; excludedSlotIds: readonly string[] }[],
  time: number,
) {
  const candidates = entries.filter((entry) => entry.state === "WAITING")
    .toSorted((a, b) => BigInt(a.admissionOrder) < BigInt(b.admissionOrder) ? -1 : 1);
  const selected = new Set<string>();
  const offers: { slotId: string; entryId: string }[] = [];
  for (const slot of freeSlots.filter((slot) => slot.startsAt > Math.floor(time))
    .toSorted((a, b) => a.startsAt - b.startsAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const entry = candidates.find((entry) => !selected.has(entry.id) && !entry.excludedSlotIds.includes(slot.id));
    if (!entry) continue;
    selected.add(entry.id);
    offers.push({ slotId: slot.id, entryId: entry.id });
  }
  return offers;
}
