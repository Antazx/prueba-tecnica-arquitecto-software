export type FailurePlan = { kind: "retry"; attempt: number; notBefore: number } |
  { kind: "park"; reason: "permanent" | "exhausted" };

export function planFailure(attempt: number, permanent: boolean, failedAt: number): FailurePlan {
  if (permanent) return { kind: "park", reason: "permanent" };
  const delay = [5000, 30000, 120000][attempt];
  if (delay === undefined) return { kind: "park", reason: "exhausted" };
  return { kind: "retry", attempt: attempt + 1, notBefore: failedAt + delay };
}
