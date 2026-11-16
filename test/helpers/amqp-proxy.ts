import { connect, createServer, type Socket } from "node:net";

// A TCP fault boundary: real broker replies are retained without changing AMQP callbacks.
export async function amqpProxy(rabbitmqUrl: string) {
  const target = new URL(rabbitmqUrl);
  const upstream = { host: target.hostname, port: Number(target.port || 5672) };
  const peers: { client: Socket; broker: Socket; paused: boolean; replies: Buffer[]; closed: boolean }[] = [];
  const connectionTimes: number[] = [];
  let available = true;
  const server = createServer((client) => {
    connectionTimes.push(performance.now());
    if (!available) { client.destroy(); return; }
    const broker = connect(upstream);
    const peer = { client, broker, paused: false, replies: [] as Buffer[], closed: false };
    peers.push(peer);
    client.pipe(broker);
    broker.on("data", (chunk: Buffer) => { if (peer.paused) peer.replies.push(chunk); else client.write(chunk); });
    broker.on("end", () => { if (!peer.paused) client.end(); });
    for (const socket of [client, broker]) {
      socket.on("error", () => {});
      socket.on("close", () => { peer.closed = true; client.destroy(); broker.destroy(); });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected proxy address");
  target.hostname = "127.0.0.1"; target.port = String(address.port);
  return {
    url: target.toString(), peers, connectionTimes,
    setAvailable(value: boolean) {
      available = value;
      if (!value) for (const peer of peers) { peer.client.destroy(); peer.broker.destroy(); }
    },
    release(index: number) {
      const peer = peers[index]; peer.paused = false;
      for (const reply of peer.replies.splice(0)) if (!peer.client.destroyed) peer.client.write(reply);
    },
    async close() {
      for (const peer of peers) { peer.client.destroy(); peer.broker.destroy(); }
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
