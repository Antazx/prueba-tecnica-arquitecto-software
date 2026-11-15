function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function port(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = environment[name] === undefined ? fallback : Number(environment[name]);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

export function readApiConfig(environment = process.env) {
  return {
    databaseUrl: required(environment, "DATABASE_URL"),
    host: environment.HOST ?? "127.0.0.1",
    port: port(environment, "API_PORT", 3000),
  };
}

export function readWorkerConfig(environment = process.env) {
  return {
    databaseUrl: required(environment, "DATABASE_URL"),
    rabbitmqUrl: required(environment, "RABBITMQ_URL"),
    host: environment.HOST ?? "127.0.0.1",
    healthPort: port(environment, "WORKER_HEALTH_PORT", 3001),
  };
}
