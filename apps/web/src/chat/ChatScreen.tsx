import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChannelSummary } from "@relay-chat/shared";
import { useAuth } from "../auth/AuthProvider.js";
import { Button } from "../components/ui/button.js";
import { chatApi } from "./api.js";
import { SocketProvider, useChatSocket, type SocketFactory } from "./SocketProvider.js";
import { MessageList } from "./MessageList.js";
import { Composer } from "./Composer.js";
import { mergeMessages } from "./model.js";

function Conversation({ channel, userId }: { channel: ChannelSummary; userId: string }) {
  const socket = useChatSocket();
  const client = useQueryClient();
  const [atBottom, setAtBottom] = useState(true);
  const lastRead = useRef<string | null>(null);
  const history = useInfiniteQuery({
    queryKey: ["messages", channel.id],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => chatApi.history(channel.id, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const { watch, connected, retry } = socket;
  useEffect(() => {
    if (history.data && channel.isMember)
      watch(channel.id, history.data.pages[0]?.messages[0]?.id ?? null);
  }, [channel.id, channel.isMember, history.data, watch, connected]);
  const messages = useMemo(
    () =>
      mergeMessages(
        history.data?.pages.flatMap((page) => page.messages) ?? [],
        socket.live[channel.id] ?? [],
        Object.values(socket.sends).filter((send) => send.payload.channelId === channel.id),
        userId,
      ),
    [history.data, socket.live, socket.sends, channel.id, userId],
  );
  const latestId = [...messages].reverse().find((message) => message.id !== null)?.id ?? null;
  const read = useMutation({
    mutationFn: (id: string) => chatApi.read(channel.id, id),
    retry: false,
    onSuccess: (_data, id) => {
      lastRead.current = id;
      void client.invalidateQueries({ queryKey: ["channels"] });
    },
  });
  const markRead = read.mutate;
  useEffect(() => {
    if (!atBottom || !channel.isMember || !latestId || latestId === lastRead.current) return;
    const update = () => {
      if (document.visibilityState === "visible" && latestId !== lastRead.current)
        markRead(latestId);
    };
    const timer = setTimeout(update, 500);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [atBottom, channel.isMember, latestId, markRead]);
  const join = useMutation({
    mutationFn: () => chatApi.join(channel.id),
    retry: false,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["channels"] });
    },
  });
  const retrySend = useCallback(
    (clientMessageId: string) => retry(channel.id, clientMessageId),
    [retry, channel.id],
  );
  const typingCount = socket.typingUsers[channel.id]?.length ?? 0;
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-card"
      aria-label={`Channel ${channel.name}`}
    >
      <header className="flex items-center justify-between gap-4 border-b border-border px-4 py-4 sm:px-6">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">
            {channel.isPrivate ? "Private · " : "# "}
            {channel.name}
          </h2>
          <p className="text-xs text-muted-foreground">
            {channel.isMember
              ? "Your conversation, in real time"
              : "Preview this public conversation"}
          </p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {connected ? "Connected" : "Offline"}
        </span>
      </header>
      {history.isPending ? (
        <p role="status" className="p-6">
          Loading messages…
        </p>
      ) : history.isError && !history.data ? (
        <div className="p-6">
          <p role="alert" className="mb-3 text-sm text-destructive">
            Couldn’t load messages.
          </p>
          <Button
            onClick={() => {
              void history.refetch();
            }}
          >
            Try again
          </Button>
        </div>
      ) : (
        <MessageList
          messages={messages}
          currentUserId={userId}
          hasOlder={history.hasNextPage}
          loadingOlder={history.isFetchingNextPage}
          historyError={history.isFetchNextPageError}
          loadOlder={() => {
            void history.fetchNextPage();
          }}
          retry={retrySend}
          onAtBottomChange={setAtBottom}
          newMessageCount={socket.live[channel.id]?.length ?? 0}
        />
      )}
      <div
        className="min-h-7 px-4 py-1 text-xs text-muted-foreground"
        aria-label="Typing indicator"
      >
        {typingCount
          ? `${typingCount === 1 ? "Someone is" : `${typingCount} people are`} typing…`
          : ""}
      </div>
      {read.isError && (
        <div className="flex items-center gap-3 px-4 py-2">
          <p className="text-xs text-destructive">Couldn’t update your read position.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (latestId) markRead(latestId);
            }}
          >
            Try marking as read again
          </Button>
        </div>
      )}
      {channel.isMember ? (
        <Composer channelId={channel.id} channelName={channel.name} disabled={!history.data} />
      ) : (
        <div className="border-t border-border p-5">
          <p className="mb-3 text-sm text-muted-foreground">
            Join this channel to send messages and see live updates.
          </p>
          <Button disabled={join.isPending} onClick={() => join.mutate()}>
            {join.isPending ? "Joining…" : "Join channel"}
          </Button>
          {join.isError && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              Couldn’t join this channel. Please try again.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function ChatWorkspace() {
  const { user, logout } = useAuth();
  const socket = useChatSocket();
  const [selected, setSelected] = useState<string | null>(null);
  const channels = useQuery({
    queryKey: ["channels"],
    queryFn: ({ signal }) => chatApi.channels(signal),
    retry: false,
  });
  const signout = useMutation({ mutationFn: logout, retry: false });
  const active =
    channels.data?.channels.find((channel) => channel.id === selected) ??
    channels.data?.channels[0];
  const onlineCount = (channel: ChannelSummary) => {
    if (!socket.connected) return 0;
    const ids = new Set(channel.onlineUserIds.filter((id) => socket.presence[id] !== "offline"));
    if (channel.isMember && user) ids.add(user.id);
    return ids.size;
  };
  const onlineUsers = [
    ...new Set([
      ...(channels.data?.channels.flatMap((channel) => channel.onlineUserIds) ?? []),
      ...Object.keys(socket.presence),
    ]),
  ].filter((id) => id !== user?.id && socket.presence[id] !== "offline" && socket.connected);
  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <aside
        className="flex w-40 shrink-0 flex-col border-r border-border bg-background sm:w-64"
        aria-label="Workspace"
      >
        <div className="border-b border-border p-3 sm:p-5">
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">
            Your workspace
          </p>
          <h1 className="mt-2 text-sm font-semibold">Welcome, {user?.displayName}.</h1>
          <p className="mt-1 truncate text-xs text-muted-foreground">{user?.email}</p>
          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <span
              aria-hidden="true"
              className={`size-2 rounded-full ${socket.connected ? "bg-primary" : "bg-muted-foreground"}`}
            />
            {socket.connected ? "You’re online" : "You’re offline"}
          </div>
        </div>
        <nav aria-label="Channels" className="min-h-0 flex-1 overflow-y-auto p-2 sm:p-3">
          <h2 className="mb-3 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Channels
          </h2>
          {channels.isPending && (
            <p role="status" className="p-2 text-sm">
              Loading channels…
            </p>
          )}
          {channels.isError && (
            <div className="p-2">
              <p role="alert" className="mb-2 text-sm text-destructive">
                Couldn’t load channels.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void channels.refetch();
                }}
              >
                Try again
              </Button>
            </div>
          )}
          {channels.data?.channels.map((channel) => (
            <button
              key={channel.id}
              type="button"
              aria-current={channel.id === active?.id ? "page" : undefined}
              className={`mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${channel.id === active?.id ? "bg-primary/10 font-semibold text-primary" : "hover:bg-muted"}`}
              onClick={() => setSelected(channel.id)}
            >
              <span
                role="img"
                aria-label={
                  onlineCount(channel)
                    ? `${onlineCount(channel)} ${onlineCount(channel) === 1 ? "member" : "members"} online`
                    : "No online members reported"
                }
                className={`size-2 shrink-0 rounded-full ${onlineCount(channel) ? "bg-primary" : "border border-muted-foreground"}`}
              />
              <span className="min-w-0 flex-1 truncate">
                {channel.isPrivate ? "▣ " : "# "}
                {channel.name}
              </span>
              {channel.unreadCount > 0 && (
                <span
                  className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground"
                  aria-label={`${channel.unreadCount} unread messages`}
                >
                  {channel.unreadCount > 99 ? "99+" : channel.unreadCount}
                </span>
              )}
            </button>
          ))}
          {channels.data?.channels.length === 0 && (
            <p className="p-2 text-sm text-muted-foreground">
              No channels yet. Your workspace’s channels will appear here.
            </p>
          )}
        </nav>
        <div className="border-t border-border p-3">
          <p className="mb-2 text-xs text-muted-foreground">Live activity</p>
          {onlineUsers.map((id) => (
            <p key={id} className="mb-2 flex items-center gap-2 truncate text-xs">
              <span aria-hidden="true" className="size-2 rounded-full bg-primary" />
              Member {id.slice(0, 6)} · online
            </p>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={signout.isPending}
            onClick={() => signout.mutate()}
          >
            Sign out
          </Button>
          {signout.isError && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              Couldn’t sign out. Check your connection and try again.
            </p>
          )}
        </div>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {socket.error && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted p-3">
            <p role="alert" className="flex-1 text-sm">
              {socket.error}
            </p>
            <Button variant="outline" size="sm" onClick={socket.resync}>
              Reconnect
            </Button>
          </div>
        )}
        {active && user ? (
          <Conversation key={active.id} channel={active} userId={user.id} />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
            Choose a channel to start a conversation.
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatScreen({ socketFactory }: { socketFactory?: SocketFactory }) {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <SocketProvider user={user} {...(socketFactory ? { socketFactory } : {})}>
      <ChatWorkspace />
    </SocketProvider>
  );
}
