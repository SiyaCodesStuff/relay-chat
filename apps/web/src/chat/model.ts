import type { MessageNew, SendState } from "@relay-chat/shared";
export type ChatMessage = {
  key: string;
  id: string | null;
  channelId: string;
  userId: string;
  clientMessageId: string;
  body: string;
  createdAt: string;
  status: "sent" | "pending" | "failed";
  error?: string;
};
export type LocalSend = SendState & { createdAt: string };
export function mergeMessages(
  history: MessageNew[],
  live: MessageNew[],
  sends: LocalSend[],
  userId: string,
): ChatMessage[] {
  const stored = new Map<string, ChatMessage>();
  const ids = new Set<string>();
  for (const message of [...history, ...live]) {
    const key = `${message.userId}:${message.clientMessageId}`;
    if (ids.has(message.id) || stored.has(key)) continue;
    ids.add(message.id);
    stored.set(key, { ...message, key, status: "sent" });
  }
  const confirmed = [...stored.values()].sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
  const pending = sends
    .filter(
      (send) => send.status !== "sent" && !stored.has(`${userId}:${send.payload.clientMessageId}`),
    )
    .map((send): ChatMessage => ({
      ...send.payload,
      key: `${userId}:${send.payload.clientMessageId}`,
      id: null,
      userId,
      createdAt: send.createdAt,
      status: send.status === "failed" ? "failed" : "pending",
      ...(send.error ? { error: send.error } : {}),
    }));
  return [...confirmed, ...pending];
}
