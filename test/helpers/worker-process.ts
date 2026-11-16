import { spawn } from "node:child_process";
import { once } from "node:events";
import { eventually, freePort } from "./concurrency.ts";

export async function startWorkerProcess(databaseUrl: string, rabbitmqUrl: string, options: { relay?: boolean; applicationName?: string; requireRabbitmq?: boolean } = {}) {
  const port = await freePort();
  const target = new URL(databaseUrl);
  target.searchParams.set("application_name", options.applicationName ?? "decision-test-worker");
  const child = spawn(process.execPath, ["src/bootstrap/worker.ts"], { cwd: process.cwd(), env: {
    ...process.env, DATABASE_URL: target.toString(), RABBITMQ_URL: rabbitmqUrl, HOST: "127.0.0.1", WORKER_HEALTH_PORT: String(port),
    RELAY_ENABLED: String(options.relay ?? true), EXPIRY_SWEEP_INTERVAL_MS: "30",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit"); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  try {
    await eventually(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Worker exited: ${logs}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
        const health = await response.json() as { dependencies: { postgres: string } };
        return options.requireRabbitmq === false ? health.dependencies.postgres === "up" : response.ok;
      } catch { return false; }
    }, Boolean, 10000);
    return { child, stop, logs: () => logs, applicationName: target.searchParams.get("application_name")! };
  } catch (error) { await stop(); throw new Error(`Worker not ready: ${logs}`, { cause: error }); }
}
