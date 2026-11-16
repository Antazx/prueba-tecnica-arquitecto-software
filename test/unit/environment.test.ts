import { expect, it } from "vitest";
import { readWorkerConfig } from "../../src/config/environment.ts";

it("requires positive transport waits and keeps relay leadership explicit", () => {
  const environment = { DATABASE_URL: "postgresql://synthetic", RABBITMQ_URL: "amqp://synthetic" };
  expect(readWorkerConfig(environment)).toMatchObject({ relayEnabled: false, outboxRetryDelayMs: 5000, publisherConfirmTimeoutMs: 5000 });
  for (const name of ["OUTBOX_RETRY_DELAY_MS", "PUBLISHER_CONFIRM_TIMEOUT_MS"]) {
    for (const value of ["0", "-1", "1.5", "NaN"]) expect(() => readWorkerConfig({ ...environment, [name]: value })).toThrow(name);
  }
});
