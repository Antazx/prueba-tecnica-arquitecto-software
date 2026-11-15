import { createServer } from "node:http";

export interface WorkerHealth {
  postgres: boolean;
  rabbitmq: boolean;
}

export function createWorkerHealthServer(state: WorkerHealth) {
  return createServer((request, response) => {
    if (request.method !== "GET" || !["/health/live", "/health/ready"].includes(request.url ?? "")) {
      response.writeHead(404).end();
      return;
    }

    const ready = state.postgres && state.rabbitmq;
    const live = request.url === "/health/live";
    response.writeHead(live || ready ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({
      service: "diagnostic-appointments-worker",
      status: live ? "alive" : ready ? "ready" : "not_ready",
      dependencies: {
        postgres: state.postgres ? "up" : "down",
        rabbitmq: state.rabbitmq ? "up" : "down",
      },
    }));
  });
}
