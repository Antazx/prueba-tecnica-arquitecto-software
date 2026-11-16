import { connect, type ChannelModel } from "amqplib";

const sockets = new WeakMap<ChannelModel, AbortController>();
const closings = new WeakMap<ChannelModel, Promise<void>>();

export async function connectToRabbitMq(url: string) {
  const controller = new AbortController();
  const socketOptions = { timeout: 5000, signal: controller.signal };
  const connection = await connect(url, socketOptions);
  sockets.set(connection, controller);
  connection.once("close", () => sockets.delete(connection));
  return connection;
}

export function closeRabbitMq(connection: ChannelModel | undefined): Promise<void> {
  if (!connection) return Promise.resolve();
  const closing = closings.get(connection);
  if (closing) return closing;
  const closed = new Promise<void>((resolve) => {
    // Connection.CloseOk may never arrive. Abort the owned socket without relying on
    // amqplib's private stream, and never reuse channels from this generation.
    const timer = setTimeout(() => { sockets.get(connection)?.abort(); resolve(); }, 500);
    void connection.close().catch(() => {}).finally(() => { clearTimeout(timer); resolve(); });
  });
  closings.set(connection, closed);
  return closed;
}
