export function parseExternalInstant(value: string): Date {
  const format = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
  const instant = new Date(value);
  const calendar = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (!format.test(value) || !Number.isFinite(instant.getTime()) ||
      !Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new Error("Invalid instant: use ISO 8601 with an explicit offset and at most three fractional digits");
  }
  return instant;
}
