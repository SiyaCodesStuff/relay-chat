// Pure functions shared by the k6 workload and Node's deterministic unit tests.
export const READY_MS = 20_000;
export const DRAIN_MS = 5_000;

export function configuration(env = {}) {
  const number = (key, fallback, minimum, maximum, integer = true) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (
      !Number.isFinite(value) ||
      value < minimum ||
      value > maximum ||
      (integer && !Number.isInteger(value))
    )
      throw new Error(`Invalid ${key}`);
    return value;
  };
  const connections = number("LOAD_CONNECTIONS", 8, 2, 4096);
  const channelSize = number("LOAD_CHANNEL_SIZE", 8, 2, 512);
  if (connections % 2 || channelSize % 2)
    throw new Error("Connection and channel sizes must be even.");
  const rate = number("LOAD_RATE", 1, 0.1, 2, false);
  const seconds = number("LOAD_SECONDS", 20, 5, 600);
  const p95 = number("LOAD_P95_MS", 500, 1, 60000);
  const messages = Math.floor(rate * seconds);
  if (!messages) throw new Error("The stated load must offer at least one message per connection.");
  return { connections, channelSize, rate, seconds, p95, messages };
}

export function group(config, vu) {
  if (!Number.isInteger(vu) || vu < 1 || vu > config.connections)
    throw new Error("Invalid VU index");
  const start = Math.floor((vu - 1) / config.channelSize) * config.channelSize + 1;
  const end = Math.min(start + config.channelSize - 1, config.connections);
  return { index: Math.floor((vu - 1) / config.channelSize), start, end, size: end - start + 1 };
}
export function expectedDeliveries(config) {
  let total = 0;
  for (let vu = 1; vu <= config.connections; vu++)
    total += group(config, vu).size * config.messages;
  return total;
}
export function reconcile(config, run, reports, persisted) {
  const planned = config.connections * config.messages;
  const ids = new Set(persisted.map((row) => row.clientMessageId));
  if (reports.size !== config.connections || persisted.length !== planned || ids.size !== planned)
    return false;
  for (let vu = 1; vu <= config.connections; vu++) {
    const report = reports.get(vu);
    const expected = group(config, vu).size * config.messages;
    if (
      !report ||
      report.expected !== expected ||
      report.received !== expected ||
      report.lost !== 0 ||
      report.submitted !== config.messages ||
      report.acknowledged !== config.messages ||
      report.failed ||
      !report.connected ||
      !report.joined
    )
      return false;
    for (let sequence = 0; sequence < config.messages; sequence++)
      if (!ids.has(messageKey(run, vu, sequence))) return false;
  }
  return true;
}
export const messageKey = (run, vu, sequence) => `${run}:${vu}:${sequence}`;
export const sendOffset = (config, vu, sequence) =>
  ((sequence + (vu - 1) / config.connections) * 1000) / config.rate;

export function encodeEvent(name, payload, acknowledgement) {
  if (!Number.isSafeInteger(acknowledgement) || acknowledgement < 0)
    throw new Error("Invalid acknowledgement ID");
  return `42${acknowledgement}${JSON.stringify([name, payload])}`;
}
export function decodePacket(wire) {
  try {
    if (typeof wire !== "string") throw new Error();
    if (wire.startsWith("0")) {
      JSON.parse(wire.slice(1));
      return { kind: "open" };
    }
    if (wire.startsWith("2")) return { kind: "ping", response: `3${wire.slice(1)}` };
    if (wire.startsWith("40")) {
      if (wire.length > 2) JSON.parse(wire.slice(2));
      return { kind: "connected" };
    }
    if (wire === "41" || wire === "1") return { kind: "closed" };
    if (wire.startsWith("44")) return { kind: "rejected" };
    if (wire.startsWith("42")) {
      const data = JSON.parse(wire.slice(2));
      if (!Array.isArray(data) || typeof data[0] !== "string") throw new Error();
      return { kind: "event", name: data[0], value: data[1] };
    }
    const match = /^43(\d+)(\[.*)$/.exec(wire);
    if (match) {
      const data = JSON.parse(match[2]);
      if (!Array.isArray(data) || data.length !== 1) throw new Error();
      return { kind: "ack", id: Number(match[1]), value: data[0] };
    }
    throw new Error();
  } catch {
    throw new Error("Malformed or unsupported Socket.IO packet");
  }
}

export class DeliveryLedger {
  constructor(config, run, vu, channelId) {
    this.config = config;
    this.run = run;
    this.vu = vu;
    this.channelId = channelId;
    this.group = group(config, vu);
    this.seen = new Set();
    this.ids = new Set();
    this.duplicates = 0;
    this.unexpected = 0;
  }
  receive(message, now) {
    let body;
    try {
      body = JSON.parse(message.body);
    } catch {
      this.unexpected++;
      return { kind: "unexpected" };
    }
    if (
      !body ||
      typeof body !== "object" ||
      message.channelId !== this.channelId ||
      body.run !== this.run ||
      !Number.isInteger(body.sender) ||
      body.sender < this.group.start ||
      body.sender > this.group.end ||
      !Number.isInteger(body.sequence) ||
      body.sequence < 0 ||
      body.sequence >= this.config.messages ||
      !Number.isFinite(body.sentAt) ||
      body.sentAt < 0 ||
      body.sentAt > now ||
      typeof message.id !== "string" ||
      !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(message.id) ||
      message.clientMessageId !== messageKey(this.run, body.sender, body.sequence)
    ) {
      this.unexpected++;
      return { kind: "unexpected" };
    }
    if (this.seen.has(message.clientMessageId) || this.ids.has(message.id)) {
      this.duplicates++;
      return { kind: "duplicate" };
    }
    this.seen.add(message.clientMessageId);
    this.ids.add(message.id);
    return {
      kind: "delivery",
      latency: now - body.sentAt,
      route: (body.sender - this.vu) % 2 === 0 ? "same-instance" : "cross-instance",
    };
  }
  get expected() {
    return this.group.size * this.config.messages;
  }
  get lost() {
    return this.expected - this.seen.size;
  }
}
