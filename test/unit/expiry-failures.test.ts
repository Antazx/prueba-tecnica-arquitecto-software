import { afterEach, expect, it, vi } from "vitest";
import { schedulingUseCases } from "../../src/scheduling/application/reservations.ts";
import { DependencyUnavailable, type Scheduling } from "../../src/scheduling/application/scheduling.ts";

function fixture() {
  const unused = async (): Promise<never> => { throw new Error("Unexpected read"); };
  const transaction = vi.fn(async (): Promise<never> => { throw new Error("Candidate failure"); });
  const due = vi.fn<Scheduling["dueTemporaryReservations"]>().mockResolvedValue({ candidates: [
    { id: "first", patientId: "synthetic-patient" }, { id: "second", patientId: "synthetic-patient" },
  ] });
  const store: Scheduling = { transaction, dueTemporaryReservations: due, patientExists: unused,
    readOwnWaitingListEntry: unused, readOwnReservation: unused };
  return { transaction, due, useCases: schedulingUseCases(store), log: vi.spyOn(console, "warn").mockImplementation(() => {}) };
}

afterEach(() => { vi.restoreAllMocks(); });

it.each([new Error("Candidate failure"), new DependencyUnavailable(new Error("Lock timeout"), "operation")])(
  "continues after a local transaction failure and reports each affected reservation: %s", async (error) => {
    const f = fixture();
    f.transaction.mockRejectedValue(error);
    await expect(f.useCases.expireTemporaryReservations()).resolves.toBe(0);
    expect(f.transaction).toHaveBeenCalledTimes(2);
    expect(f.log.mock.calls.map(([line]) => JSON.parse(String(line)).reservationId)).toEqual(["first", "second"]);
  },
);

it("aborts on a global outage and retries the interrupted page after recovery", async () => {
  const f = fixture();
  const outage = new DependencyUnavailable(new Error("Connection lost"));
  f.transaction.mockRejectedValueOnce(outage);
  await expect(f.useCases.expireTemporaryReservations()).rejects.toBe(outage);
  expect(f.transaction).toHaveBeenCalledTimes(1);
  expect(f.log).not.toHaveBeenCalled();
  await expect(f.useCases.expireTemporaryReservations()).resolves.toBe(0);
  expect(f.due.mock.calls).toEqual([[undefined], [undefined]]);
  expect(f.transaction).toHaveBeenCalledTimes(3);
});

it("propagates a failed candidate query without attempting transactions", async () => {
  const f = fixture();
  const error = new DependencyUnavailable(new Error("Connection lost"));
  f.due.mockRejectedValue(error);
  await expect(f.useCases.expireTemporaryReservations()).rejects.toBe(error);
  expect(f.transaction).not.toHaveBeenCalled();
});
