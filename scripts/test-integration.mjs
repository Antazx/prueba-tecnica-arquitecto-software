import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, devNull } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const project = `appointment-tests-${randomUUID()}`;
// The topology verifier also invokes Compose, so it needs the same explicit scope.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COMPOSE_")));
Object.assign(env, {
  COMPOSE_PROJECT_NAME: project,
  COMPOSE_FILE: fileURLToPath(new URL("../compose.yaml", import.meta.url)),
  COMPOSE_ENV_FILES: devNull,
  COMPOSE_DISABLE_ENV_FILE: "1",
  POSTGRES_PORT: "0",
  RABBITMQ_PORT: "0",
});
const compose = ["compose", "--project-name", project, "--file", env.COMPOSE_FILE, "--env-file", devNull];
let child;
let interrupted;
let finishing = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = 128 + constants.signals[signal];
    if (child?.pid && !finishing) {
      try { process.kill(-child.pid, signal); }
      catch (error) {
        if (error.code !== "ESRCH") console.error(`Could not interrupt child: ${error.message}`);
      }
    }
  });
}

function run(command, args, capture = false) {
  if (interrupted && !finishing) throw new Error("Integration run interrupted");
  return new Promise((resolve, reject) => {
    const current = spawn(command, args, {
      cwd: root, env, detached: true,
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    });
    child = current;
    let output = "";
    current.stdout?.on("data", (chunk) => { output += chunk; });
    current.on("error", reject);
    current.on("close", (code, signal) => {
      child = undefined;
      if (code === 0) resolve(output.trim());
      else reject(Object.assign(new Error(`${command} failed (${signal ?? code})`), {
        exitCode: code ?? 128 + (constants.signals[signal] ?? 0),
      }));
    });
  });
}

async function port(service, internalPort) {
  const address = await run("docker", [...compose, "port", service, internalPort], true);
  const match = /^127\.0\.0\.1:(\d+)$/.exec(address);
  if (!match) throw new Error(`Unexpected ${service} port mapping: ${address}`);
  return match[1];
}

console.info(`Integration project: ${project}`);
let exitCode = 0;
try {
  await run("docker", [...compose, "up", "-d", "--wait", "postgres", "rabbitmq"]);
  const postgresPort = await port("postgres", "5432");
  const rabbitmqPort = await port("rabbitmq", "5672");
  env.TEST_DATABASE_URL = `postgresql://diagnostic:diagnostic_dev@127.0.0.1:${postgresPort}/diagnostic_appointments`;
  env.TEST_RABBITMQ_URL = `amqp://diagnostic:diagnostic_dev@127.0.0.1:${rabbitmqPort}`;
  env.DATABASE_URL = env.TEST_DATABASE_URL;
  env.RABBITMQ_URL = env.TEST_RABBITMQ_URL;
  console.info(`Integration ports: PostgreSQL=${postgresPort}, RabbitMQ=${rabbitmqPort}`);
  await run(process.execPath, ["scripts/verify-rabbitmq.mjs"]);
  await run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "test/integration", ...process.argv.slice(2)]);
} catch (error) {
  exitCode = interrupted ?? error.exitCode ?? 1;
  console.error(error.message);
} finally {
  finishing = true;
  if (exitCode !== 0 || interrupted) {
    console.error(`Integration diagnostics before cleanup: ${project}`);
    for (const args of [["ps", "--all"], ["logs", "--no-color", "--tail", "100", "postgres", "rabbitmq"]]) {
      try { await run("docker", [...compose, ...args]); }
      catch (error) { console.error(`Diagnostics failed: ${error.message}`); }
    }
  }
  console.info(`Removing integration containers and volumes: ${project}`);
  try { await run("docker", [...compose, "down", "--volumes"]); }
  catch (error) {
    console.error(`Cleanup failed for ${project}: ${error.message}`);
    if (exitCode === 0) exitCode = error.exitCode ?? 1;
  }
}
process.exitCode = interrupted ?? exitCode;
