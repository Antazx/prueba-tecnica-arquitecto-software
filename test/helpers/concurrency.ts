import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as pause } from "node:timers/promises";
import type { Pool } from "pg";

export async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeout = 1500): Promise<T> {
  const deadline = performance.now() + timeout;
  let value: T;
  do {
    value = await read();
    if (ready(value)) return value;
    await pause(10);
  } while (performance.now() < deadline);
  throw new Error(`Condition not reached: ${JSON.stringify(value)}`);
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

interface ApiProcess { child: ChildProcess; url: string; applicationName: string; logs: () => string }

async function startApi(databaseUrl: string, applicationName: string, environment: NodeJS.ProcessEnv): Promise<ApiProcess> {
  const port = await freePort();
  const database = new URL(databaseUrl);
  database.searchParams.set("application_name", applicationName);
  const child = spawn(process.execPath, ["src/bootstrap/api.ts"], {
    cwd: process.cwd(), env: { ...process.env, ...environment, DATABASE_URL: database.toString(), HOST: "127.0.0.1", API_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const api = { child, url: `http://127.0.0.1:${port}`, applicationName, logs: () => output };
  try {
    await eventually(async () => {
      if (child.exitCode !== null) throw new Error(`API exited: ${output}`);
      try { return (await fetch(`${api.url}/health/ready`)).ok; } catch { return false; }
    }, Boolean, 8000);
    return api;
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`API not ready: ${output}`, { cause: error });
  }
}

async function stopApi(api: ApiProcess) {
  if (api.child.exitCode !== null || api.child.signalCode !== null) return;
  const exited = once(api.child, "exit");
  api.child.kill("SIGTERM");
  const timer = setTimeout(() => api.child.kill("SIGKILL"), 3000);
  try { await exited; } finally { clearTimeout(timer); }
}

export async function startApiPair(databaseUrl: string, prefix: string, environment: NodeJS.ProcessEnv = {}) {
  const a = await startApi(databaseUrl, `${prefix}-A`, environment);
  try {
    const b = await startApi(databaseUrl, `${prefix}-B`, environment);
    return { a, b, stop: async () => { await Promise.all([stopApi(a), stopApi(b)]); } };
  } catch (error) { await stopApi(a); throw error; }
}

export async function holdScope(pool: Pool, hospitalId: string, testTypeId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    await client.query(`SELECT hospital_id FROM scheduling.waiting_list_scopes
      WHERE hospital_id = $1 AND test_type_id = $2 FOR UPDATE`, [hospitalId, testTypeId]);
    let released = false;
    return { pid: result.rows[0].pid, release: async () => {
      if (released) return;
      released = true;
      try { await client.query("ROLLBACK"); } finally { client.release(); }
    } };
  } catch (error) {
    try { await client.query("ROLLBACK"); } finally { client.release(); }
    throw error;
  }
}

interface Activity {
  pid: number; application_name: string; state: string; wait_event_type: string;
  blockers: number[]; xact_start: Date; query_start: Date; query: string;
}

export async function awaitBlocked(pool: Pool, applications: string[], controllerPid: number, count = applications.length) {
  const observed = await eventually(async () => (await pool.query<Activity>(`
    SELECT pid, application_name, state, wait_event_type, pg_blocking_pids(pid) AS blockers,
      xact_start, query_start, query FROM pg_stat_activity WHERE datname = current_database()`)).rows,
  (activity) => {
    function reachesController(pid: number, visited = new Set<number>()): boolean {
      if (pid === controllerPid) return true;
      if (visited.has(pid)) return false;
      visited.add(pid);
      return activity.find((row) => row.pid === pid)?.blockers.some((blocker) => reachesController(blocker, visited)) ?? false;
    }
    const waiting = activity.filter((row) => applications.includes(row.application_name) && row.state === "active" &&
      row.wait_event_type === "Lock" && reachesController(row.pid));
    return waiting.length >= count && applications.every((name) => waiting.some((row) => row.application_name === name));
  });
  const waiting = observed.filter((row) => applications.includes(row.application_name) && row.wait_event_type === "Lock");
  process.stdout.write(`Observed API lock barrier ${JSON.stringify({ controllerPid, waiting })}\n`);
  return waiting;
}

export async function postHold(api: { url: string }, slotId: string, key: string, patientId: string) {
  const response = await fetch(`${api.url}/slots/${slotId}/holds`, {
    method: "POST", headers: { "X-Patient-Id": patientId, "Idempotency-Key": key },
  });
  return { status: response.status, body: await response.json() };
}
