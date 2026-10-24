import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  createReliableChatClient,
  messageNewSchema,
  presenceUpdateSchema,
  typingUpdateSchema,
  type MessageNew,
  type AuthUser,
} from "@relay-chat/shared";
import type { LocalSend } from "./model.js";
import {
  createChatSocket,
  type ChatSocket,
  type SocketFactory,
  type ReconnectionOptions,
} from "./socket.js";
export type { ChatSocket, SocketFactory } from "./socket.js";

type Runtime = {
  socket: ChatSocket;
  clients: Map<string, ReturnType<typeof createReliableChatClient>>;
};
type SocketContextValue = {
  connected: boolean;
  error: string | null;
  live: Record<string, MessageNew[]>;
  sends: Record<string, LocalSend>;
  presence: Record<string, "online" | "offline">;
  typingUsers: Record<string, string[]>;
  watch: (channelId: string, after: string | null) => void;
  send: (channelId: string, body: string, clientMessageId: string) => void;
  retry: (channelId: string, clientMessageId: string) => void;
  typing: (channelId: string, active: boolean) => void;
  resync: () => void;
};
const SocketContext = createContext<SocketContextValue | null>(null);

export function SocketProvider({
  children,
  user,
  socketFactory = createChatSocket,
  reconnection,
}: {
  children: ReactNode;
  user: AuthUser;
  socketFactory?: SocketFactory;
  reconnection?: ReconnectionOptions;
}) {
  const queryClient = useQueryClient();
  const runtime = useRef<Runtime | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, MessageNew[]>>({});
  const [sends, setSends] = useState<Record<string, LocalSend>>({});
  const [presence, setPresence] = useState<Record<string, "online" | "offline">>({});
  const [typingUsers, setTypingUsers] = useState<Record<string, string[]>>({});
  const typingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const lastTyped = useRef(new Map<string, number>());
  const syncErrors = useRef(new Set<string>());

  const receive = useCallback((message: MessageNew) => {
    setLive((previous) => {
      const channel = previous[message.channelId] ?? [];
      if (
        channel.some(
          (old) =>
            old.id === message.id ||
            (old.userId === message.userId && old.clientMessageId === message.clientMessageId),
        )
      )
        return previous;
      return {
        ...previous,
        [message.channelId]: [...channel, message].sort((a, b) => a.id.localeCompare(b.id)),
      };
    });
  }, []);

  useEffect(() => {
    const socket = socketFactory(reconnection);
    const state: Runtime = { socket, clients: new Map() };
    runtime.current = state;
    let invalidateTimer: ReturnType<typeof setTimeout> | undefined;
    const invalidate = () => {
      if (invalidateTimer) return;
      invalidateTimer = setTimeout(() => {
        invalidateTimer = undefined;
        void queryClient.invalidateQueries({ queryKey: ["channels"] });
      }, 750);
    };
    socket.on("connect", () => {
      setConnected(true);
      setError(null);
      invalidate();
    });
    socket.on("disconnect", () => {
      setConnected(false);
      setTypingUsers({});
    });
    socket.on("connect_error", () => {
      setConnected(false);
      setError("Connection unavailable. Messages will stay queued while you reconnect.");
    });
    socket.on("message:new", (raw) => {
      const parsed = messageNewSchema.safeParse(raw);
      if (parsed.success) {
        receive(parsed.data);
        invalidate();
      }
    });
    socket.on("presence:update", (raw) => {
      const parsed = presenceUpdateSchema.safeParse(raw);
      if (parsed.success) {
        setPresence((old) => ({ ...old, [parsed.data.userId]: parsed.data.status }));
        invalidate();
      }
    });
    const stop = (channelId: string, userId: string) => {
      const key = `${channelId}:${userId}`;
      clearTimeout(typingTimers.current.get(key));
      typingTimers.current.delete(key);
      setTypingUsers((old) => ({
        ...old,
        [channelId]: (old[channelId] ?? []).filter((id) => id !== userId),
      }));
    };
    socket.on("typing:start", (raw) => {
      const parsed = typingUpdateSchema.safeParse(raw);
      if (!parsed.success || parsed.data.userId === user.id) return;
      const { channelId, userId } = parsed.data;
      const key = `${channelId}:${userId}`;
      clearTimeout(typingTimers.current.get(key));
      setTypingUsers((old) => ({
        ...old,
        [channelId]: [...new Set([...(old[channelId] ?? []), userId])],
      }));
      typingTimers.current.set(
        key,
        setTimeout(() => stop(channelId, userId), 3_500),
      );
    });
    socket.on("typing:stop", (raw) => {
      const parsed = typingUpdateSchema.safeParse(raw);
      if (parsed.success) stop(parsed.data.channelId, parsed.data.userId);
    });
    socket.connect();
    const timers = typingTimers.current;
    return () => {
      runtime.current = null;
      clearTimeout(invalidateTimer);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const client of state.clients.values()) client.dispose();
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [queryClient, receive, reconnection, socketFactory, user.id]);

  const watch = useCallback(
    (channelId: string, after: string | null) => {
      const state = runtime.current;
      if (!state || state.clients.has(channelId)) return;
      const client = createReliableChatClient({
        socket: state.socket,
        channels: { [channelId]: after },
        onMessage: receive,
        onSendState: (send) =>
          setSends((old) => ({
            ...old,
            [send.payload.clientMessageId]: {
              ...send,
              createdAt: old[send.payload.clientMessageId]?.createdAt ?? new Date().toISOString(),
            },
          })),
        onSyncError: () => {
          syncErrors.current.add(channelId);
          setError(
            "Couldn’t catch up on messages. Your queued messages are safe; try reconnecting.",
          );
        },
        onSynced: () => {
          syncErrors.current.delete(channelId);
          if (!syncErrors.current.size) setError(null);
        },
      });
      state.clients.set(channelId, client);
    },
    [receive],
  );
  const send = useCallback((channelId: string, body: string, clientMessageId: string) => {
    const client = runtime.current?.clients.get(channelId);
    if (!client) throw new Error("The channel is still loading. Please try again.");
    client.send({ channelId, body, clientMessageId });
  }, []);
  const retry = useCallback((channelId: string, clientMessageId: string) => {
    runtime.current?.clients.get(channelId)?.retry(clientMessageId);
  }, []);
  const typing = useCallback((channelId: string, active: boolean) => {
    const socket = runtime.current?.socket;
    if (!socket?.connected) return;
    const now = Date.now();
    if (active && now - (lastTyped.current.get(channelId) ?? 0) < 1_000) return;
    lastTyped.current.set(channelId, active ? now : 0);
    socket.emit(active ? "typing:start" : "typing:stop", { channelId });
  }, []);
  const resync = useCallback(() => {
    const state = runtime.current;
    if (!state) return;
    if (!state.socket.connected) state.socket.connect();
    else for (const client of state.clients.values()) void client.reconnect();
  }, []);

  return (
    <SocketContext.Provider
      value={{
        connected,
        error,
        live,
        sends,
        presence,
        typingUsers,
        watch,
        send,
        retry,
        typing,
        resync,
      }}
    >
      {children}
    </SocketContext.Provider>
  );
}
export function useChatSocket() {
  const value = useContext(SocketContext);
  if (!value) throw new Error("SocketProvider is required.");
  return value;
}
