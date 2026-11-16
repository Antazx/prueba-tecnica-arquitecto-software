import type { Writable } from "node:stream";
import type { NotificationWriter } from "../application/messages.ts";

export function structuredNotificationWriter(output: Writable = process.stdout): NotificationWriter {
  return (notification) => new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Writable invokes the callback before emitting its error on the next tick.
      if (error) setImmediate(() => output.off("error", finish));
      else output.off("error", finish);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Notification output timed out")), 5000);
    output.once("error", finish);
    try { output.write(`${JSON.stringify(notification)}\n`, finish); }
    catch (error) { finish(error instanceof Error ? error : new Error("Notification output failed")); }
  });
}
