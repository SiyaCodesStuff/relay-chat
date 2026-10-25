import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReliableChatClient,
  type MessageNew,
  type ReliableSocket,
  type SendState,
} from "../src/index.js";

const channelId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
function message(index: number): MessageNew {
  return {
    id: String(index).padStart(26, "0"),
    channelId,
    userId,
    clientMessageId: `client-${index}`,
    body: `Message ${index}`,
    createdAt: "2026-10-22T00:00:00.000Z",
    editedAt: null,
  };
}

class FakeSocket {
  connected = false;
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  calls: { event: string; payload: unknown; ack: (value: unknown) => void }[] = [];
  on(event: string, listener: (...args: never[]) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener as (...args: unknown[]) => void);
    this.listeners.set(event, listeners);
  }
  off(event: string, listener: (...args: never[]) => void) {
    this.listeners.get(event)?.delete(listener as (...args: unknown[]) => void);
  }
  emit(event: string, payload: unknown, ack: (value: unknown) => void) {
    this.calls.push({ event, payload, ack });
  }
  fire(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  connect() {
    this.connected = true;
    this.fire("connect");
  }
  drop() {
    this.connected = false;
    this.fire("disconnect");
  }
  reply(index: number, payload: unknown) {
    this.calls[index]?.ack(payload);
  }
}

function setup() {
  vi.useFakeTimers();
  const socket = new FakeSocket();
  const received: MessageNew[] = [];
  const states: SendState[] = [];
  const errors: string[] = [];
  const client = createReliableChatClient({
    socket: socket as ReliableSocket,
    channels: { [channelId]: null },
    onMessage: (value) => received.push(value),
    onSendState: (value) => states.push(value),
    onSyncError: (_id, error) => errors.push(error),
    acknowledgementTimeoutMs: 100,
    maxAttempts: 2,
  });
  return { socket, client, received, states, errors };
}
afterEach(() => vi.useRealTimers());

describe("reliable chat client", () => {
  it("rejects malformed or mismatched acknowledgements without publishing a message", async () => {
    const { socket, client, received } = setup();
    socket.connect();
    socket.reply(0, { ok: true, messages: [], hasMore: false });
    await vi.advanceTimersByTimeAsync(0);
    client.send({ channelId, body: "test", clientMessageId: "client-1" });
    socket.reply(1, { ok: true, message: message(2) });
    expect(client.getSends()[0]).toMatchObject({ status: "failed", error: "INVALID_ACK" });
    client.retry("client-1");
    socket.reply(2, { unexpected: "payload" });
    expect(client.getSends()[0]).toMatchObject({ status: "failed", error: "INVALID_ACK" });
    expect(received).toEqual([]);
    client.dispose();
  });

  it.each([
    { ok: true, messages: [], hasMore: true },
    { ok: true, messages: [{ ...message(1), channelId: userId }], hasMore: false },
    { ok: false, error: { code: "NOT_A_MEMBER" } },
    { invalid: true },
  ])("surfaces rejected catch-up replies and leaves offline sends queued: %j", async (reply) => {
    const { socket, client, errors } = setup();
    client.send({ channelId, body: "queued", clientMessageId: "queued" });
    socket.connect();
    socket.reply(0, reply);
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual(["ok" in reply && reply.ok === false ? "NOT_A_MEMBER" : "INVALID_ACK"]);
    expect(client.getSends()[0]?.status).toBe("queued");
    expect(socket.calls).toHaveLength(1);
    client.dispose();
  });

  it("bounds offline queues and rejects untracked channels without sending", () => {
    const { socket, client } = setup();
    expect(() =>
      client.send({ channelId: userId, body: "wrong", clientMessageId: "wrong" }),
    ).toThrow("CHANNEL_NOT_TRACKED");
    for (let i = 0; i < 100; i++)
      client.send({ channelId, body: "queued", clientMessageId: `queue-${i}` });
    expect(() => client.send({ channelId, body: "overflow", clientMessageId: "overflow" })).toThrow(
      "SEND_QUEUE_FULL",
    );
    expect(
      client.send({ channelId, body: "duplicate", clientMessageId: "queue-0" }).payload.body,
    ).toBe("queued");
    expect(client.getSends()).toHaveLength(100);
    expect(socket.calls).toHaveLength(0);
    client.dispose();
  });
  it("buffers live events during paged catch-up and dedupes both identifiers", async () => {
    const { socket, client, received } = setup();
    socket.connect();
    socket.fire("message:new", message(3));
    socket.reply(0, { ok: true, messages: [message(1), message(2)], hasMore: true });
    expect(socket.calls[1]?.payload).toEqual({ channelId, after: message(2).id });
    socket.reply(1, { ok: true, messages: [message(3)], hasMore: false });
    await vi.advanceTimersByTimeAsync(0);
    socket.fire("message:new", message(3));
    socket.fire("message:new", { ...message(3), id: message(4).id });
    expect(received.map((value) => value.id)).toEqual([
      message(1).id,
      message(2).id,
      message(3).id,
    ]);
    client.dispose();
  });

  it("queues offline and unacked sends and keeps the same id after a dropped connection", async () => {
    const { socket, client, received } = setup();
    const payload = { channelId, body: "offline", clientMessageId: "client-1" };
    client.send(payload);
    expect(socket.calls).toHaveLength(0);
    socket.connect();
    socket.reply(0, { ok: true, messages: [], hasMore: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.calls[1]?.payload).toEqual(payload);
    socket.drop();
    socket.reply(1, { ok: true, message: message(1) }); // stale ack ignored
    socket.connect();
    expect(socket.calls[2]?.payload).toEqual({ channelId, after: null, lastSeen: null });
    socket.reply(2, { ok: true, messages: [message(1)], hasMore: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.calls[3]?.payload).toEqual(payload);
    socket.reply(3, { ok: true, message: message(1) });
    expect(received).toEqual([message(1)]);
    expect(client.getSends()[0]?.status).toBe("sent");
    client.dispose();
  });

  it("times out, retries with the original id, and exposes exhaustion and explicit retry", async () => {
    const { socket, client, states } = setup();
    socket.connect();
    socket.reply(0, { ok: true, messages: [], hasMore: false });
    await vi.advanceTimersByTimeAsync(0);
    const payload = { channelId, body: "test", clientMessageId: "client-1" };
    client.send(payload);
    await vi.advanceTimersByTimeAsync(200);
    expect(socket.calls.slice(1).map((call) => call.payload)).toEqual([payload, payload]);
    expect(states.at(-1)).toMatchObject({ status: "failed", error: "ACK_TIMEOUT" });
    client.retry(payload.clientMessageId);
    socket.reply(3, { ok: false, error: { code: "NOT_A_MEMBER" } });
    expect(client.getSends()[0]).toMatchObject({ status: "failed", error: "NOT_A_MEMBER" });
    client.dispose();
  });

  it("surfaces sync timeouts without flushing offline sends", async () => {
    const { socket, client, errors } = setup();
    client.send({ channelId, body: "offline", clientMessageId: "pending" });
    socket.connect();
    await vi.advanceTimersByTimeAsync(100);
    expect(errors).toEqual(["SYNC_TIMEOUT"]);
    expect(socket.calls).toHaveLength(1);
    expect(client.getSends()[0]?.status).toBe("queued");
    client.dispose();
  });
});
