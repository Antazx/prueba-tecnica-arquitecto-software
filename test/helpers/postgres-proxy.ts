import { connect, createServer, type Socket } from "node:net";

// Faults are applied to real PostgreSQL protocol replies, after the server decides.
export async function postgresProxy(databaseUrl: string) {
  const target = new URL(databaseUrl);
  const upstream = { host: target.hostname, port: Number(target.port || 5432) };
  const peers: { client: Socket; server: Socket }[] = [];
  let dropCommit = false;
  let holdRollback = false;
  let rollbackObserved = false;
  let held: { client: Socket; frames: Buffer[] } | undefined;
  let available = true;
  const proxy = createServer((client) => {
    if (!available) { client.destroy(); return; }
    const server = connect(upstream);
    peers.push({ client, server });
    let replies = Buffer.alloc(0);
    let requests = Buffer.alloc(0);
    let startup = true;
    let lastQuery = "";
    client.on("data", (chunk: Buffer) => {
      server.write(chunk);
      requests = Buffer.concat([requests, chunk]);
      while (requests.length >= (startup ? 4 : 5)) {
        const length = requests.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (requests.length < length) break;
        const frame = requests.subarray(0, length); requests = requests.subarray(length);
        if (startup) { startup = false; continue; }
        if (frame[0] === 81) lastQuery = frame.subarray(5, -1).toString();
      }
    });
    server.on("data", (chunk: Buffer) => {
      replies = Buffer.concat([replies, chunk]);
      while (replies.length >= 5) {
        const length = replies.readInt32BE(1) + 1;
        if (replies.length < length) break;
        const frame = replies.subarray(0, length); replies = replies.subarray(length);
        if (dropCommit && frame[0] === 67 && frame.subarray(5, -1).toString() === "COMMIT") {
          dropCommit = false; client.destroy(); server.destroy(); return;
        }
        if (holdRollback && lastQuery === "ROLLBACK") {
          held ??= { client, frames: [] }; held.frames.push(frame);
          if (frame[0] === 90) { rollbackObserved = true; holdRollback = false; }
        } else client.write(frame);
      }
    });
    for (const socket of [client, server]) {
      socket.on("error", () => {});
      socket.on("close", () => { client.destroy(); server.destroy(); });
    }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Expected PostgreSQL proxy address");
  target.hostname = "127.0.0.1"; target.port = String(address.port);
  return {
    url: target.toString(),
    setAvailable(value: boolean) {
      available = value;
      if (!value) for (const peer of peers) { peer.client.destroy(); peer.server.destroy(); }
    },
    dropNextCommit() { dropCommit = true; },
    holdNextRollback() { holdRollback = true; rollbackObserved = false; },
    get rolledBack() { return rollbackObserved; },
    releaseRollback() { if (held) for (const frame of held.frames) held.client.write(frame); held = undefined; },
    async close() {
      for (const peer of peers) { peer.client.destroy(); peer.server.destroy(); }
      await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
    },
  };
}
