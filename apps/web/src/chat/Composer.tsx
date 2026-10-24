import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.js";
import { useChatSocket } from "./SocketProvider.js";
export function Composer({
  channelId,
  channelName,
  disabled = false,
}: {
  channelId: string;
  channelName: string;
  disabled?: boolean;
}) {
  const { send, typing, connected } = useChatSocket();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      typing(channelId, false);
    },
    [channelId, typing],
  );
  function submit() {
    if (disabled || !body.trim()) return;
    try {
      send(channelId, body.trim(), crypto.randomUUID());
      setBody("");
      setError(null);
      clearTimeout(timer.current);
      typing(channelId, false);
    } catch {
      setError("Couldn’t queue this message. Keep your draft and try again.");
    }
  }
  return (
    <form
      aria-label="Message composer"
      className="border-t border-border bg-card p-3 sm:p-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label htmlFor="message-draft" className="sr-only">
        Message #{channelName}
      </label>
      <textarea
        id="message-draft"
        value={body}
        rows={2}
        maxLength={4_000}
        disabled={disabled}
        aria-describedby="composer-help"
        placeholder={`Message #${channelName}`}
        className="block w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        onChange={(event) => {
          setBody(event.target.value);
          typing(channelId, Boolean(event.target.value.trim()));
          clearTimeout(timer.current);
          timer.current = setTimeout(() => typing(channelId, false), 1_800);
        }}
        onBlur={() => typing(channelId, false)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <p id="composer-help" className="text-xs text-muted-foreground">
          {connected
            ? "Enter to send · Shift+Enter for a new line"
            : "Offline · messages stay queued until you reconnect"}
        </p>
        <Button size="sm" type="submit" disabled={disabled || !body.trim()}>
          Send message
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
