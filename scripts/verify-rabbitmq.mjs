import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const definitions = JSON.parse(readFileSync(new URL("../rabbitmq/definitions.json", import.meta.url)));
const inspect = (...args) => JSON.parse(execFileSync("docker", ["compose", "exec", "-T", "rabbitmq", "rabbitmqctl", ...args, "--formatter=json"], { encoding: "utf8" }));
const queues = inspect("list_queues", "name", "type", "durable", "arguments", "policy", "effective_policy_definition");
const policies = inspect("list_policies");
assert.deepEqual(inspect("list_operator_policies"), []);
const bindings = inspect("list_bindings", "source_name", "destination_name", "destination_kind", "routing_key");
const flags = inspect("list_feature_flags", "name", "state");
for (const expected of definitions.queues) {
  const actual = queues.find((queue) => queue.name === expected.name);
  assert.ok(actual, `Missing queue ${expected.name}`);
  actual.arguments = Object.fromEntries(actual.arguments.map(([key, _type, value]) => [key, value]));
  assert.equal(actual.type, "quorum"); assert.equal(actual.durable, true);
  for (const [key, value] of Object.entries(expected.arguments)) assert.equal(actual.arguments[key], value);
  assert.ok(!("x-message-ttl" in actual.arguments) && !("x-expires" in actual.arguments) && !("x-max-length" in actual.arguments));
  if (expected.name.endsWith(".dlq")) {
    assert.equal(actual.arguments["x-delivery-limit"], -1);
    assert.ok(!actual.policy);
    assert.ok(!("x-dead-letter-exchange" in actual.arguments));
  } else {
    const policy = definitions.policies.find((item) => new RegExp(item.pattern).test(expected.name));
    assert.equal(actual.policy, policy.name);
    assert.deepEqual(actual.effective_policy_definition, policy.definition);
    const definition = policies.find((item) => item.name === policy.name).definition;
    assert.deepEqual(typeof definition === "string" ? JSON.parse(definition) : definition, policy.definition);
  }
}
for (const expected of definitions.bindings) {
  assert.ok(bindings.some((binding) => binding.source_name === expected.source && binding.destination_name === expected.destination &&
    binding.destination_kind === "queue" && binding.routing_key === expected.routing_key));
}
for (const name of ["quorum_queue", "stream_queue"]) assert.equal(flags.find((flag) => flag.name === name)?.state, "enabled");
console.info(JSON.stringify({ event: "rabbitmq_topology_verified", queues: definitions.queues.map((queue) => queue.name), policies: definitions.policies, flags: flags.filter((flag) => ["quorum_queue", "stream_queue"].includes(flag.name)) }));
