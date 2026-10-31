/* global __ENV */
import http from "k6/http";
import exec from "k6/execution";
import { WebSocket } from "k6/websockets";
import { setTimeout, clearTimeout } from "k6/timers";
import { Counter, Rate, Trend } from "k6/metrics";
import {
  configuration,
  group,
  expectedDeliveries,
  messageKey,
  sendOffset,
  encodeEvent,
  decodePacket,
  DeliveryLedger,
  READY_MS,
  DRAIN_MS,
} from "./protocol.mjs";

const config = configuration(__ENV);
const broker = __ENV.LOAD_BROKER;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(broker ?? ""))
  throw new Error("A local load fixture broker is required.");
const planned = config.connections * config.messages;
const control = { "X-Load-Key": __ENV.LOAD_CONTROL_KEY };
const connected = new Counter("connected_clients");
const joined = new Counter("joined_clients");
const sent = new Counter("submitted_messages");
const acknowledged = new Counter("acked_messages");
const receipts = new Counter("received_deliveries");
const lost = new Counter("lost_deliveries");
const duplicates = new Counter("duplicate_deliveries");
const protocolErrors = new Counter("protocol_errors");
const errors = new Rate("send_error_rate");
const delivery = new Trend("delivery_latency_ms", true);
const crossDelivery = new Trend("cross_instance_delivery_latency_ms", true);
const ackLatency = new Trend("ack_latency_ms", true);
const lag = new Trend("generator_lag_ms", true);
const knownCodes = new Set([
  "INVALID_PAYLOAD",
  "NOT_AUTHENTICATED",
  "NOT_A_MEMBER",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);

export const options = {
  scenarios: {
    chat: {
      executor: "per-vu-iterations",
      vus: config.connections,
      iterations: 1,
      maxDuration: `${READY_MS + config.seconds * 1000 + DRAIN_MS + 5000}ms`,
      gracefulStop: "0s",
    },
  },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max"],
  thresholds: {
    connected_clients: [`count==${config.connections}`],
    joined_clients: [`count==${config.connections}`],
    submitted_messages: [`count==${planned}`],
    acked_messages: [`count==${planned}`],
    received_deliveries: [`count==${expectedDeliveries(config)}`],
    lost_deliveries: ["count==0"],
    duplicate_deliveries: ["count==0"],
    protocol_errors: ["count==0"],
    "protocol_errors{code:INTERNAL_ERROR}": ["count==0"],
    "protocol_errors{code:RATE_LIMITED}": ["count==0"],
    send_error_rate: ["rate==0"],
    delivery_latency_ms: [`p(95)<${config.p95}`],
    cross_instance_delivery_latency_ms: [`p(95)<${config.p95}`],
    generator_lag_ms: ["p(95)<100"],
  },
};

export default async function () {
  const vu = exec.vu.idInTest;
  let ledger = new DeliveryLedger(config, __ENV.LOAD_RUN, vu, "unavailable");
  let submitted = 0;
  const successful = new Set();
  const starts = new Map();
  let connectionSucceeded = false;
  let joinSucceeded = false;
  let failed = false;
  const protocolError = (code) => {
    failed = true;
    protocolErrors.add(1, { code: knownCodes.has(code) ? code : "TRANSPORT_OR_PROTOCOL" });
  };
  const identity = http.get(`${broker}/identity/${vu}`, {
    headers: control,
    tags: { name: "load-identity" },
  });
  if (identity.status !== 200) protocolError("fixture");
  else {
    const fixture = identity.json();
    const session = identity.cookies.relay_session?.[0]?.value;
    if (!session || fixture.channelIndex !== group(config, vu).index) protocolError("fixture");
    else {
      ledger = new DeliveryLedger(config, __ENV.LOAD_RUN, vu, fixture.channelId);
      await new Promise((resolve) => {
        let finished = false;
        let normalClose = false;
        const timers = new Set();
        const socket = new WebSocket(
          `${fixture.api.replace(/^http/, "ws")}/socket.io/?EIO=4&transport=websocket`,
          null,
          {
            headers: { Origin: fixture.origin, Cookie: `relay_session=${session}` },
            tags: { instance: String((vu - 1) % 2) },
          },
        );
        const schedule = (fn, ms) => {
          const timer = setTimeout(
            () => {
              timers.delete(timer);
              fn();
            },
            Math.max(0, ms),
          );
          timers.add(timer);
        };
        const finish = () => {
          if (finished) return;
          finished = true;
          for (const timer of timers) clearTimeout(timer);
          timers.clear();
          if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            normalClose = true;
            socket.close();
          }
          resolve();
        };
        schedule(() => {
          protocolError("readiness deadline");
          finish();
        }, READY_MS);
        socket.onerror = () => {
          protocolError("transport");
          finish();
        };
        socket.onclose = () => {
          if (!normalClose) protocolError("unexpected close");
          finish();
        };
        socket.onmessage = (event) => {
          if (finished) return;
          try {
            const packet = decodePacket(event.data);
            if (packet.kind === "open") socket.send("40");
            else if (packet.kind === "ping") socket.send(packet.response);
            else if (packet.kind === "connected") {
              connectionSucceeded = true;
              connected.add(1);
              socket.send(encodeEvent("channel:join", { channelId: fixture.channelId }, 1));
            } else if (packet.kind === "ack" && packet.id === 1) {
              if (packet.value?.ok !== true) {
                protocolError(packet.value?.error?.code);
                finish();
                return;
              }
              joinSucceeded = true;
              joined.add(1);
              // One readiness barrier, not a retry loop. All recipients have joined before sends begin.
              const response = http.post(`${broker}/ready/${vu}`, null, {
                headers: control,
                timeout: `${READY_MS}ms`,
                tags: { name: "load-barrier" },
              });
              if (response.status !== 200) {
                protocolError("barrier");
                finish();
                return;
              }
              const { startAt, stopAt } = response.json();
              for (const timer of timers) clearTimeout(timer);
              timers.clear();
              for (let sequence = 0; sequence < config.messages; sequence++) {
                const scheduledAt = startAt + sendOffset(config, vu, sequence);
                schedule(() => {
                  if (socket.readyState !== WebSocket.OPEN) {
                    protocolError("not open");
                    return;
                  }
                  const sentAt = Date.now();
                  lag.add(sentAt - scheduledAt);
                  starts.set(sequence + 2, sentAt);
                  socket.send(
                    encodeEvent(
                      "message:send",
                      {
                        channelId: fixture.channelId,
                        clientMessageId: messageKey(__ENV.LOAD_RUN, vu, sequence),
                        body: JSON.stringify({ run: __ENV.LOAD_RUN, sender: vu, sequence, sentAt }),
                      },
                      sequence + 2,
                    ),
                  );
                  submitted++;
                  sent.add(1);
                }, scheduledAt - Date.now());
              }
              schedule(finish, stopAt + DRAIN_MS - Date.now());
            } else if (packet.kind === "ack") {
              const sequence = packet.id - 2;
              if (
                !starts.has(packet.id) ||
                successful.has(sequence) ||
                packet.value?.ok !== true ||
                packet.value.message?.clientMessageId !==
                  messageKey(__ENV.LOAD_RUN, vu, sequence) ||
                packet.value.message?.channelId !== fixture.channelId
              )
                protocolError(packet.value?.error?.code);
              else {
                successful.add(sequence);
                acknowledged.add(1);
                ackLatency.add(Date.now() - starts.get(packet.id));
              }
            } else if (packet.kind === "event" && packet.name === "message:new") {
              const outcome = ledger.receive(packet.value, Date.now());
              if (outcome.kind === "delivery") {
                receipts.add(1);
                delivery.add(outcome.latency);
                if (outcome.route === "cross-instance") crossDelivery.add(outcome.latency);
              } else if (outcome.kind === "unexpected") protocolError("unexpected message");
            } else if (packet.kind === "event" && packet.name === "error")
              protocolError(packet.value?.code);
            else if (packet.kind === "closed" || packet.kind === "rejected") {
              protocolError("closed");
              finish();
            }
          } catch {
            protocolError("invalid packet");
            finish();
          }
        };
      });
    }
  }
  lost.add(ledger.lost);
  duplicates.add(ledger.duplicates);
  protocolErrors.add(0);
  // Count every planned send, including unsent or unacknowledged sends, in the denominator.
  for (let sequence = 0; sequence < config.messages; sequence++)
    errors.add(!successful.has(sequence));
  const report = http.post(
    `${broker}/report/${vu}`,
    JSON.stringify({
      submitted,
      acknowledged: successful.size,
      expected: ledger.expected,
      received: ledger.seen.size,
      lost: ledger.lost,
      duplicates: ledger.duplicates,
      connected: connectionSucceeded,
      joined: joinSucceeded,
      failed,
    }),
    { headers: { ...control, "Content-Type": "application/json" }, tags: { name: "load-report" } },
  );
  if (report.status !== 204) protocolErrors.add(1, { code: "CONTROL_REPORT" });
}

export function handleSummary(data) {
  const metrics = data.metrics;
  return {
    [__ENV.LOAD_SUMMARY]: JSON.stringify({ metrics }, null, 2),
    stdout: `${JSON.stringify({
      latency_p95_ms: metrics.delivery_latency_ms?.values?.["p(95)"],
      cross_instance_p95_ms: metrics.cross_instance_delivery_latency_ms?.values?.["p(95)"],
      lost: metrics.lost_deliveries?.values?.count,
      send_error_rate: metrics.send_error_rate?.values?.rate,
    })}\n`,
  };
}
