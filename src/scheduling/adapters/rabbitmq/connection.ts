import { connect } from "amqplib";

export function connectToRabbitMq(url: string) {
  return connect(url, { timeout: 5000 });
}
