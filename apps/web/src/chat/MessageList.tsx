/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The named scroll region must accept focus for native keyboard scrolling. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/button.js";
import { MessageBody } from "./MessageBody.js";
import type { ChatMessage } from "./model.js";

const estimate = 104;
const bottomThreshold = 32;
type Anchor = { key: string | undefined; offset: number; bottom: boolean };
function anchorAt(
  items: ChatMessage[],
  offsets: number[],
  top: number,
  height: number,
  total: number,
): Anchor {
  let index = 0;
  while (index < items.length - 1 && (offsets[index + 1] ?? total) <= top) index += 1;
  return {
    key: items[index]?.key,
    offset: top - (offsets[index] ?? 0),
    bottom: total - top - height <= bottomThreshold,
  };
}

export function MessageList({
  messages,
  currentUserId,
  hasOlder,
  loadingOlder,
  historyError,
  loadOlder,
  retry,
  onAtBottomChange,
  newMessageCount = 0,
}: {
  messages: ChatMessage[];
  currentUserId: string;
  hasOlder: boolean;
  loadingOlder: boolean;
  historyError?: boolean;
  loadOlder: () => void;
  retry: (clientMessageId: string) => void;
  onAtBottomChange: (value: boolean) => void;
  newMessageCount?: number;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const previous = useRef<Anchor | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 480 });
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [atBottom, setAtBottom] = useState(true);
  const [announcement, setAnnouncement] = useState({ text: "", sequence: 0 });
  const pendingAnnouncements = useRef(0);
  const priorCount = useRef(newMessageCount);
  const announcementTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const layout = useMemo(() => {
    const offsets: number[] = [];
    let total = 0;
    for (const message of messages) {
      offsets.push(total);
      total += heights[message.key] ?? estimate;
    }
    return { offsets, total };
  }, [messages, heights]);
  let start = 0;
  while (
    start < messages.length &&
    (layout.offsets[start] ?? 0) + (heights[messages[start]?.key ?? ""] ?? estimate) <
      viewport.top - 300
  )
    start += 1;
  let end = start;
  while (end < messages.length && (layout.offsets[end] ?? 0) < viewport.top + viewport.height + 300)
    end += 1;
  const visible = messages.slice(start, end);

  const reportScroll = useCallback(
    (element: HTMLDivElement) => {
      const height = element.clientHeight || 480;
      const anchor = anchorAt(messages, layout.offsets, element.scrollTop, height, layout.total);
      previous.current = anchor;
      setViewport({ top: element.scrollTop, height });
      setAtBottom(anchor.bottom);
      onAtBottomChange(anchor.bottom);
    },
    [messages, layout, onAtBottomChange],
  );

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const height = element.clientHeight || 480;
    const anchor = previous.current;
    let target = element.scrollTop;
    if (!anchor || anchor.bottom) target = Math.max(0, layout.total - height);
    else if (anchor.key) {
      const index = messages.findIndex((message) => message.key === anchor.key);
      if (index !== -1) target = (layout.offsets[index] ?? 0) + anchor.offset;
    }
    element.scrollTop = target;
    reportScroll(element);
  }, [layout, messages, reportScroll]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const updates: Record<string, number> = {};
      for (const entry of entries) {
        if (entry.target === element) {
          reportScroll(element);
          continue;
        }
        const key = (entry.target as HTMLElement).dataset.messageKey;
        const height =
          entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
        if (key && height > 0) updates[key] = Math.ceil(height);
      }
      setHeights((old) =>
        Object.entries(updates).some(([key, height]) => old[key] !== height)
          ? { ...old, ...updates }
          : old,
      );
    });
    observer.observe(element);
    for (const row of element.querySelectorAll("[data-message-key]")) observer.observe(row);
    return () => observer.disconnect();
  }, [start, end, messages, reportScroll]);

  useEffect(() => {
    pendingAnnouncements.current += Math.max(0, newMessageCount - priorCount.current);
    priorCount.current = newMessageCount;
    if (pendingAnnouncements.current && !announcementTimer.current) {
      announcementTimer.current = setTimeout(() => {
        const count = pendingAnnouncements.current;
        pendingAnnouncements.current = 0;
        announcementTimer.current = undefined;
        setAnnouncement((old) => ({
          text: `${count} new ${count === 1 ? "message" : "messages"}.`,
          sequence: old.sequence + 1,
        }));
      }, 2_000);
    }
  }, [newMessageCount]);
  useEffect(() => () => clearTimeout(announcementTimer.current), []);

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Conversation">
      <div className="flex min-h-10 items-center justify-center border-b border-border px-3 py-1">
        {hasOlder ? (
          <Button variant="outline" size="sm" disabled={loadingOlder} onClick={loadOlder}>
            {loadingOlder
              ? "Loading older messages…"
              : historyError
                ? "Try loading older messages again"
                : "Load older messages"}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">Beginning of conversation</p>
        )}
      </div>
      <div
        ref={scroller}
        role="region"
        aria-label="Messages"
        tabIndex={0}
        aria-busy={loadingOlder}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none [overflow-anchor:none] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onScroll={(event) => {
          reportScroll(event.currentTarget);
          if (event.currentTarget.scrollTop < 80 && hasOlder && !loadingOlder && !historyError)
            loadOlder();
        }}
      >
        <div
          role="list"
          aria-label="Message history"
          style={{ height: Math.max(layout.total, 1), position: "relative" }}
        >
          {visible.map((message, index) => (
            <article
              role="listitem"
              aria-posinset={start + index + 1}
              aria-setsize={messages.length}
              key={message.key}
              data-message-key={message.key}
              className="absolute inset-x-0 px-4 py-3 sm:px-6"
              style={{ top: layout.offsets[start + index] }}
            >
              <div className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-xs font-semibold text-primary"
                >
                  {message.userId === currentUserId ? "Y" : "M"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-semibold">
                      {message.userId === currentUserId
                        ? "You"
                        : `Member ${message.userId.slice(0, 6)}`}
                    </span>
                    <time dateTime={message.createdAt} className="text-xs text-muted-foreground">
                      {new Date(message.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                  <div className="text-sm leading-relaxed">
                    <MessageBody body={message.body} />
                  </div>
                  {message.status === "pending" && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Pending · waiting for confirmation
                    </p>
                  )}
                  {message.status === "failed" && (
                    <div className="mt-2 flex items-center gap-3">
                      <p className="text-xs text-destructive">Message failed to send</p>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Retry message: ${message.body.slice(0, 40)}`}
                        onClick={() => retry(message.clientMessageId)}
                      >
                        Retry
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
        {!messages.length && (
          <p className="p-8 text-center text-sm text-muted-foreground">
            Start the conversation. Say hello.
          </p>
        )}
      </div>
      {!atBottom && (
        <Button
          variant="outline"
          size="sm"
          className="mx-auto my-2"
          onClick={() => {
            if (scroller.current) {
              scroller.current.scrollTop = Math.max(
                0,
                layout.total - (scroller.current.clientHeight || 480),
              );
              reportScroll(scroller.current);
              scroller.current.focus({ preventScroll: true });
            }
          }}
        >
          Jump to latest messages
        </Button>
      )}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        <span key={announcement.sequence}>{announcement.text}</span>
      </p>
    </section>
  );
}
