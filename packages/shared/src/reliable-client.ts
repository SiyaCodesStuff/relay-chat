import {
  channelSyncAcknowledgementSchema,
  messageNewSchema,
  messageSendAcknowledgementSchema,
  messageSendSchema,
  type ChannelSync,
  type ClientToServerEvents,
  type MessageNew,
  type MessageSend,
} from "./index.js";

export interface ReliableSocket {
  readonly connected: boolean;
  on(event: "connect" | "disconnect", listener: () => void): unknown;
  on(event: "message:new", listener: (message: MessageNew) => void): unknown;
  off(event: "connect" | "disconnect", listener: () => void): unknown;
  off(event: "message:new", listener: (message: MessageNew) => void): unknown;
  emit(event: "message:send", ...args: Parameters<ClientToServerEvents["message:send"]>): unknown;
  emit(event: "channel:sync", ...args: Parameters<ClientToServerEvents["channel:sync"]>): unknown;
}

export type SendState = {
  payload: MessageSend;
  status: "queued" | "sending" | "sent" | "failed";
  attempts: number;
  error?: string;
};

type Options = {
  socket: ReliableSocket;
  // Seed these from history when creating the client. null requests all history.
  channels: Record<string, string | null>;
  onMessage: (message: MessageNew) => void;
  onSendState: (state: SendState) => void;
  onSyncError: (channelId: string, error: string) => void;
  onSynced?: () => void;
  acknowledgementTimeoutMs?: number;
  maxAttempts?: number;
  maxQueuedSends?: number;
};

export function createReliableChatClient(options: Options) {
  const { socket } = options;
  const timeoutMs = options.acknowledgementTimeoutMs ?? 5_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const cursors = new Map(Object.entries(options.channels));
  const lastSeen = new Map(Object.entries(options.channels));
  const messagesById = new Map<string, MessageNew>();
  const seenClientIds = new Set<string>();
  const sends = new Map<string, SendState>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const syncTimers = new Set<ReturnType<typeof setTimeout>>();
  let generation = 0;
  let synced = false;
  let disposed = false;
  let buffered: MessageNew[] = [];

  function publish(state: SendState) {
    options.onSendState({ ...state, payload: { ...state.payload } });
  }

  function receive(message: MessageNew, advanceCursor: boolean) {
    const seen = lastSeen.get(message.channelId);
    if (!seen || message.id > seen) lastSeen.set(message.channelId, message.id);
    const key = `${message.userId}:${message.clientMessageId}`;
    if (!messagesById.has(message.id) && !seenClientIds.has(key)) {
      messagesById.set(message.id, message);
      seenClientIds.add(key);
      options.onMessage(message);
    }
    if (advanceCursor) {
      const cursor = cursors.get(message.channelId);
      if (!cursor || message.id > cursor) cursors.set(message.channelId, message.id);
    }
  }

  function clearSendTimer(id: string) {
    clearTimeout(timers.get(id));
    timers.delete(id);
  }

  function attempt(state: SendState) {
    if (
      !socket.connected ||
      !synced ||
      disposed ||
      state.status === "sent" ||
      state.status === "failed"
    )
      return;
    clearSendTimer(state.payload.clientMessageId);
    state.status = "sending";
    state.attempts += 1;
    delete state.error;
    const attemptNumber = state.attempts;
    const currentGeneration = generation;
    publish(state);
    timers.set(
      state.payload.clientMessageId,
      setTimeout(() => {
        timers.delete(state.payload.clientMessageId);
        if (state.status !== "sending") return;
        state.error = "ACK_TIMEOUT";
        state.status = state.attempts >= maxAttempts ? "failed" : "queued";
        publish(state);
        if (state.status === "queued") attempt(state);
      }, timeoutMs),
    );
    socket.emit("message:send", state.payload, (raw) => {
      if (
        disposed ||
        currentGeneration !== generation ||
        attemptNumber !== state.attempts ||
        state.status !== "sending"
      )
        return;
      clearSendTimer(state.payload.clientMessageId);
      const result = messageSendAcknowledgementSchema.safeParse(raw);
      if (!result.success || !result.data.ok) {
        state.status = "failed";
        state.error = result.success && !result.data.ok ? result.data.error.code : "INVALID_ACK";
      } else if (
        result.data.message.clientMessageId !== state.payload.clientMessageId ||
        result.data.message.channelId !== state.payload.channelId
      ) {
        state.status = "failed";
        state.error = "INVALID_ACK";
      } else {
        state.status = "sent";
        receive(result.data.message, false);
      }
      publish(state);
    });
  }

  function syncPage(payload: ChannelSync, currentGeneration: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        syncTimers.delete(timer);
        reject(new Error("SYNC_TIMEOUT"));
      }, timeoutMs);
      syncTimers.add(timer);
      socket.emit("channel:sync", payload, (raw) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        syncTimers.delete(timer);
        if (generation !== currentGeneration || disposed) {
          resolve();
          return;
        }
        const result = channelSyncAcknowledgementSchema.safeParse(raw);
        if (!result.success) {
          reject(new Error("INVALID_ACK"));
          return;
        }
        if (!result.data.ok) {
          reject(new Error(result.data.error.code));
          return;
        }
        let cursor = payload.after;
        for (const message of result.data.messages) {
          if (
            message.channelId !== payload.channelId ||
            (cursor !== null && message.id <= cursor)
          ) {
            reject(new Error("INVALID_ACK"));
            return;
          }
          receive(message, true);
          cursor = message.id;
        }
        if (result.data.hasMore) {
          if (cursor === payload.after) {
            reject(new Error("INVALID_ACK"));
            return;
          }
          resolve(syncPage({ channelId: payload.channelId, after: cursor }, currentGeneration));
        } else resolve();
      });
    });
  }

  async function reconnect() {
    if (disposed || !socket.connected) return;
    const currentGeneration = ++generation;
    synced = false;
    for (const [channelId, after] of cursors) {
      try {
        await syncPage(
          { channelId, after, lastSeen: lastSeen.get(channelId) ?? null },
          currentGeneration,
        );
      } catch (error) {
        if (currentGeneration === generation && !disposed)
          options.onSyncError(channelId, error instanceof Error ? error.message : "SYNC_FAILED");
        return;
      }
      if (generation !== currentGeneration || disposed) return;
    }
    buffered.sort((a, b) => a.id.localeCompare(b.id));
    for (const message of buffered) receive(message, false);
    buffered = [];
    synced = true;
    options.onSynced?.();
    for (const state of sends.values()) if (state.status === "queued") attempt(state);
  }

  function disconnect() {
    generation += 1;
    synced = false;
    for (const [id, state] of sends) {
      clearSendTimer(id);
      if (state.status === "sending") {
        state.status = state.attempts >= maxAttempts ? "failed" : "queued";
        if (state.status === "failed") state.error = "DISCONNECTED";
        publish(state);
      }
    }
    // Leave sync timeouts to settle their promises; stale generations cannot apply replies.
  }

  function liveMessage(raw: MessageNew) {
    const parsed = messageNewSchema.safeParse(raw);
    if (!parsed.success || !cursors.has(parsed.data.channelId)) return;
    // Only catch-up replies advance the checkpoint: live pub/sub events can arrive out of order.
    if (synced) receive(parsed.data, false);
    else buffered.push(parsed.data);
  }

  socket.on("connect", reconnect);
  socket.on("disconnect", disconnect);
  socket.on("message:new", liveMessage);
  if (socket.connected) void reconnect();

  return {
    send(raw: MessageSend) {
      const payload = messageSendSchema.parse(raw);
      const existing = sends.get(payload.clientMessageId);
      if (existing) return { ...existing };
      if (!cursors.has(payload.channelId)) throw new Error("CHANNEL_NOT_TRACKED");
      if (
        [...sends.values()].filter((state) => state.status !== "sent").length >=
        (options.maxQueuedSends ?? 100)
      )
        throw new Error("SEND_QUEUE_FULL");
      const state: SendState = { payload, status: "queued", attempts: 0 };
      sends.set(payload.clientMessageId, state);
      publish(state);
      attempt(state);
      return { ...state };
    },
    retry(clientMessageId: string) {
      const state = sends.get(clientMessageId);
      if (!state || state.status !== "failed") return;
      state.status = "queued";
      state.attempts = 0;
      delete state.error;
      publish(state);
      attempt(state);
    },
    reconnect,
    getCursors: () => Object.fromEntries(cursors),
    getLastSeen: () => Object.fromEntries(lastSeen),
    getMessages: () => [...messagesById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    getSends: () =>
      [...sends.values()].map((state) => ({ ...state, payload: { ...state.payload } })),
    dispose() {
      disposed = true;
      disconnect();
      for (const timer of syncTimers) clearTimeout(timer);
      socket.off("connect", reconnect);
      socket.off("disconnect", disconnect);
      socket.off("message:new", liveMessage);
    },
  };
}
