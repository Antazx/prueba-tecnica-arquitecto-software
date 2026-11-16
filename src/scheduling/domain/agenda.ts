export interface AgendaInterval {
  id: string;
  resourceId: string;
  startsAt: number;
  endsAt: number;
}

export function validateAgenda(slots: readonly AgendaInterval[]): void {
  for (const slot of slots) {
    if (Math.floor(slot.startsAt) >= Math.floor(slot.endsAt)) {
      throw new Error(`Slot ${slot.id} has an empty interval`);
    }
  }
  const ordered = [...slots].sort((left, right) =>
    left.resourceId.localeCompare(right.resourceId) || left.startsAt - right.startsAt,
  );
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous.resourceId === current.resourceId &&
        Math.floor(current.startsAt) < Math.floor(previous.endsAt)) {
      throw new Error(`Slots ${previous.id} and ${current.id} overlap`);
    }
  }
}
