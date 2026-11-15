import Fastify from "fastify";

export function buildApi(checkPostgres: () => Promise<void>) {
  const api = Fastify({ logger: true });

  api.get("/health/live", async () => ({
    service: "diagnostic-appointments-api",
    status: "alive",
  }));

  api.get("/health/ready", async (_request, reply) => {
    try {
      await checkPostgres();
      return { status: "ready", dependencies: { postgres: "up" } };
    } catch {
      return reply.code(503).send({
        status: "not_ready",
        dependencies: { postgres: "down" },
      });
    }
  });

  return api;
}
