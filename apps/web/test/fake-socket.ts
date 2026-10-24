type Listener = (...args: unknown[]) => void;
export class FakeChatSocket {
  connected = false;
  listeners = new Map<string, Set<Listener>>();
  sends: {
    payload: { channelId: string; body: string; clientMessageId: string };
    ack: Listener;
  }[] = [];
  typing: string[] = [];
  on(event: string, listener: Listener) {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }
  off(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  emit(event: string, payload: unknown, acknowledgement?: Listener) {
    if (event === "channel:sync") acknowledgement?.({ ok: true, messages: [], hasMore: false });
    if (event === "message:send" && acknowledgement)
      this.sends.push({
        payload: payload as { channelId: string; body: string; clientMessageId: string },
        ack: acknowledgement,
      });
    if (event.startsWith("typing:")) this.typing.push(event);
    return this;
  }
  fire(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  connect() {
    this.connected = true;
    queueMicrotask(() => this.fire("connect"));
    return this;
  }
  disconnect() {
    this.connected = false;
    this.fire("disconnect");
    return this;
  }
  removeAllListeners() {
    this.listeners.clear();
    return this;
  }
}
