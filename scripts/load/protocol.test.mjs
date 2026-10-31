import { test } from "node:test";
import assert from "node:assert/strict";
import {
  configuration,
  group,
  expectedDeliveries,
  sendOffset,
  messageKey,
  encodeEvent,
  decodePacket,
  DeliveryLedger,
  reconcile,
} from "./protocol.mjs";

test("configuration bounds preserve the existing socket flood limit and state a nonzero load", () => {
  assert.equal(configuration().rate, 1);
  for (const env of [
    { LOAD_CONNECTIONS: "3" },
    { LOAD_CHANNEL_SIZE: "3" },
    { LOAD_RATE: "3" },
    { LOAD_RATE: "NaN" },
    { LOAD_SECONDS: "1" },
    { LOAD_SECONDS: "5", LOAD_RATE: "0.1" },
  ])
    assert.throws(() => configuration(env));
});
test("partial channel groups and offered load include every recipient", () => {
  const config = configuration({
    LOAD_CONNECTIONS: "10",
    LOAD_CHANNEL_SIZE: "4",
    LOAD_SECONDS: "5",
  });
  assert.deepEqual(group(config, 10), { index: 2, start: 9, end: 10, size: 2 });
  assert.equal(expectedDeliveries(config), (4 * 4 + 4 * 4 + 2 * 2) * 5);
  assert.throws(() => group(config, 11));
  for (let vu = 1; vu <= 10; vu++)
    assert.ok(sendOffset(config, vu, config.messages - 1) < config.seconds * 1000);
});
test("Socket.IO framing handles Engine.IO heartbeat, acks and connect denial without echoing wire content", () => {
  assert.equal(
    encodeEvent("channel:join", { channelId: "channel" }, 1),
    '421["channel:join",{"channelId":"channel"}]',
  );
  assert.deepEqual(decodePacket('431[{"ok":true}]'), { kind: "ack", id: 1, value: { ok: true } });
  assert.equal(decodePacket('0{"sid":"not-a-real-session"}').kind, "open");
  assert.deepEqual(decodePacket("2probe"), { kind: "ping", response: "3probe" });
  assert.equal(decodePacket('40{"sid":"connection"}').kind, "connected");
  assert.equal(decodePacket('44{"message":"rejected"}').kind, "rejected");
  for (const packet of ["42[", "43x[]", "431[{},{}]", "42[1]", "private-marker"])
    assert.throws(
      () => decodePacket(packet),
      (error) => !error.message.includes("private-marker"),
    );
});
const config = configuration({ LOAD_CONNECTIONS: "4", LOAD_CHANNEL_SIZE: "2", LOAD_SECONDS: "5" });
function stored(sender = 1, sequence = 0, id = "00000000000000000000000001") {
  return {
    id,
    channelId: "channel",
    clientMessageId: messageKey("run", sender, sequence),
    body: JSON.stringify({ run: "run", sender, sequence, sentAt: 100 }),
  };
}
test("latency is send-to-receive and lost means exact missing identities, including cross-instance delivery", () => {
  const ledger = new DeliveryLedger(config, "run", 2, "channel");
  assert.equal(ledger.expected, 10);
  assert.deepEqual(ledger.receive(stored(), 125), {
    kind: "delivery",
    latency: 25,
    route: "cross-instance",
  });
  assert.equal(ledger.lost, 9);
  for (let sender = 1; sender <= 2; sender++)
    for (let sequence = 0; sequence < 5; sequence++) {
      if (sender === 1 && sequence === 0) continue;
      ledger.receive(
        stored(sender, sequence, String(sender * 10 + sequence).padStart(26, "0")),
        125,
      );
    }
  assert.equal(ledger.lost, 0);
});
test("duplicates cannot compensate for a lost message, and invalid identities never count as delivery", () => {
  const ledger = new DeliveryLedger(config, "run", 1, "channel");
  ledger.receive(stored(), 120);
  ledger.receive(stored(), 121);
  ledger.receive(stored(1, 0, "00000000000000000000000002"), 122);
  ledger.receive(stored(2, 0), 122); // repeated server ID with a different client ID
  assert.equal(ledger.lost, 9);
  assert.equal(ledger.duplicates, 3);
  for (const value of [
    stored(3),
    stored(1, 99),
    { ...stored(), channelId: "other" },
    { ...stored(), body: "<script>bad</script>" },
    stored(1, 1),
  ])
    ledger.receive(value, 99); // includes invalid/future timestamps
  assert.equal(ledger.lost, 9);
  assert.equal(ledger.unexpected, 5);
});

test("reconciliation rejects missing clients, acks, rows and same-count wrong identities", () => {
  const reports = new Map();
  const rows = [];
  for (let vu = 1; vu <= config.connections; vu++) {
    reports.set(vu, {
      expected: 10,
      received: 10,
      lost: 0,
      submitted: 5,
      acknowledged: 5,
      failed: false,
      connected: true,
      joined: true,
    });
    for (let sequence = 0; sequence < 5; sequence++)
      rows.push({ clientMessageId: messageKey("run", vu, sequence) });
  }
  assert.equal(reconcile(config, "run", reports, rows), true);
  assert.equal(reconcile(config, "run", new Map([...reports].slice(1)), rows), false);
  assert.equal(reconcile(config, "run", reports, rows.slice(1)), false);
  assert.equal(
    reconcile(config, "run", reports, [{ clientMessageId: "unexpected-id" }, ...rows.slice(1)]),
    false,
  );
  const failed = new Map(reports);
  failed.set(1, { ...reports.get(1), acknowledged: 4 });
  assert.equal(reconcile(config, "run", failed, rows), false);
  failed.set(1, { ...reports.get(1), joined: false });
  assert.equal(reconcile(config, "run", failed, rows), false);
});
