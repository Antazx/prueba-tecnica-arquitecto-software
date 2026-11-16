export interface SlotQuery {
  hospitalId: string;
  testTypeId: string;
  from: Date;
  to: Date;
}

export interface SlotView {
  id: string;
  resourceId: string;
  hospitalId: string;
  testTypeId: string;
  startsAt: string;
  endsAt: string;
  directlyBookable: boolean;
}

export interface AgendaSnapshot {
  evaluatedAt: string;
  slots: SlotView[];
}

export type AgendaReader = (query: SlotQuery) => Promise<AgendaSnapshot>;
