import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { ChatScreen } from "../src/chat/ChatScreen.js";
import { AuthProvider } from "../src/auth/AuthProvider.js";
import { MessageBody } from "../src/chat/MessageBody.js";
import { MessageList } from "../src/chat/MessageList.js";
import { mergeMessages, type ChatMessage } from "../src/chat/model.js";
import type { ChatSocket } from "../src/chat/SocketProvider.js";
import type { MessageNew } from "@relay-chat/shared";
import { FakeChatSocket } from "./fake-socket.js";
import { apiOrigin, server, testUser } from "./server.js";

const channelId = "00000000-0000-4000-8000-000000000002";
const channel = {
  id: channelId,
  name: "general",
  isPrivate: false,
  isMember: true,
  onlineUserIds: [],
  unreadCount: 3,
  createdBy: testUser.id,
};
function stored(index: number, body = `Message ${index}`): MessageNew {
  return {
    id: String(index).padStart(26, "0"),
    channelId,
    userId: testUser.id,
    clientMessageId: `client-${index}`,
    body,
    createdAt: "2026-10-23T10:00:00.000Z",
    editedAt: null,
  };
}
function rows(count: number, from = 1): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    ...stored(index + from),
    key: `key-${index + from}`,
    status: "sent",
  }));
}

function renderChat(socket = new FakeChatSocket(), history: MessageNew[] = []) {
  server.use(
    http.get(`${apiOrigin}/api/v1/auth/me`, () => HttpResponse.json({ user: testUser })),
    http.get(`${apiOrigin}/api/v1/channels`, () => HttpResponse.json({ channels: [channel] })),
    http.get(`${apiOrigin}/api/v1/channels/${channelId}/messages`, () =>
      HttpResponse.json({ messages: history, nextCursor: null }),
    ),
    http.post(
      `${apiOrigin}/api/v1/channels/${channelId}/read`,
      () => new HttpResponse(null, { status: 204 }),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const socketFactory = () => socket as unknown as ChatSocket;
  render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <ChatScreen socketFactory={socketFactory} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return socket;
}

describe("chat screen", () => {
  async function readyComposer() {
    const input = await screen.findByRole("textbox", { name: "Message #general" });
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));
    return input;
  }
  it("shows an optimistic send and replaces it once with broadcast plus acknowledgement", async () => {
    const socket = renderChat();
    const composer = await readyComposer();
    const user = userEvent.setup();
    await user.type(composer, "Hello team{Enter}");
    expect(await screen.findByText("Hello team")).toBeTruthy();
    expect(screen.getByText("Pending · waiting for confirmation")).toBeTruthy();
    expect((composer as HTMLTextAreaElement).value).toBe("");
    expect(socket.sends).toHaveLength(1);
    const call = socket.sends[0];
    if (!call) throw new Error("Send was not captured.");
    const message = { ...stored(1), ...call.payload };
    act(() => {
      socket.fire("message:new", message);
      call.ack({ ok: true, message });
    });
    expect(screen.getAllByText("Hello team")).toHaveLength(1);
    expect(screen.queryByText("Pending · waiting for confirmation")).toBeNull();
    expect(screen.getByLabelText("3 unread messages")).toBeTruthy();
    expect(screen.getByRole("img", { name: "1 member online" })).toBeTruthy();
  });

  it("surfaces a failed send and retries with the same client message id", async () => {
    const socket = renderChat();
    const input = await readyComposer();
    await userEvent.setup().type(input, "Try me{Enter}");
    const first = socket.sends[0];
    if (!first) throw new Error("Send was not captured.");
    act(() => first.ack({ ok: false, error: { code: "INTERNAL_ERROR" } }));
    expect(await screen.findByText("Message failed to send")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry message: Try me" }));
    expect(socket.sends).toHaveLength(2);
    const second = socket.sends[1];
    expect(second?.payload.clientMessageId).toBe(first.payload.clientMessageId);
    act(() => second?.ack({ ok: true, message: { ...stored(1), ...first.payload } }));
    expect(screen.getAllByText("Try me")).toHaveLength(1);
    expect(screen.queryByText("Message failed to send")).toBeNull();
  });

  it("keeps Shift+Enter as a newline and queues messages during a disconnect", async () => {
    const socket = renderChat();
    const input = await readyComposer();
    const user = userEvent.setup();
    await user.type(input, "First{Shift>}{Enter}{/Shift}Second");
    expect((input as HTMLTextAreaElement).value).toBe("First\nSecond");
    expect(socket.sends).toHaveLength(0);
    act(() => {
      socket.disconnect();
    });
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Pending · waiting for confirmation")).toBeTruthy();
    expect(socket.sends).toHaveLength(0);
    act(() => {
      socket.connect();
    });
    await waitFor(() => expect(socket.sends).toHaveLength(1));
  });

  it("uses the REST history cursor when loading older messages", async () => {
    renderChat(undefined, [stored(3), stored(2)]);
    const requests: (string | null)[] = [];
    server.use(
      http.get(`${apiOrigin}/api/v1/channels/${channelId}/messages`, ({ request }) => {
        const before = new URL(request.url).searchParams.get("before");
        requests.push(before);
        return HttpResponse.json(
          before
            ? { messages: [stored(1)], nextCursor: null }
            : { messages: [stored(3), stored(2)], nextCursor: stored(2).id },
        );
      }),
    );
    const load = await screen.findByRole("button", { name: "Load older messages" });
    await userEvent.setup().click(load);
    expect(await screen.findByText("Message 1")).toBeTruthy();
    expect(requests).toEqual([null, stored(2).id]);
  });

  it("displays typing updates and expires them locally", async () => {
    const socket = renderChat();
    await readyComposer();
    vi.useFakeTimers();
    try {
      act(() =>
        socket.fire("typing:start", { channelId, userId: "00000000-0000-4000-8000-000000000003" }),
      );
      expect(screen.getByLabelText("Typing indicator").textContent).toBe("Someone is typing…");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_500);
      });
      expect(screen.getByLabelText("Typing indicator").textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks read only at the bottom and when the document becomes visible", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    renderChat(
      undefined,
      Array.from({ length: 10 }, (_, index) => stored(10 - index)),
    );
    const read = vi.fn();
    server.use(
      http.post(`${apiOrigin}/api/v1/channels/${channelId}/read`, async ({ request }) => {
        read(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await readyComposer();
    const region = screen.getByRole("region", { name: "Messages" });
    region.scrollTop = 100;
    fireEvent.scroll(region);
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    expect(read).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole("button", { name: "Jump to latest messages" }));
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(read).toHaveBeenCalledWith({ messageId: stored(10).id }));
  });
});

describe("virtual history scrolling", () => {
  function props(messages: ChatMessage[]) {
    return {
      messages,
      currentUserId: testUser.id,
      hasOlder: false,
      loadingOlder: false,
      loadOlder: vi.fn(),
      retry: vi.fn(),
      onAtBottomChange: vi.fn(),
    };
  }
  function viewport() {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  }
  it("virtualizes rows and preserves the visible anchor when older history is prepended", () => {
    viewport();
    const initial = rows(40, 6);
    const options = props(initial);
    const { rerender } = render(<MessageList {...options} />);
    const region = screen.getByRole("region", { name: "Messages" });
    expect(within(region).getAllByRole("listitem").length).toBeLessThan(20);
    region.scrollTop = 500;
    fireEvent.scroll(region);
    rerender(<MessageList {...options} messages={[...rows(5), ...initial]} />);
    expect(region.scrollTop).toBe(1_020);
  });
  it("only follows new messages while the reader is at the bottom", () => {
    viewport();
    const initial = rows(20);
    const options = props(initial);
    const { rerender } = render(<MessageList {...options} />);
    const region = screen.getByRole("region", { name: "Messages" });
    expect(region.scrollTop).toBe(1_680);
    rerender(<MessageList {...options} messages={rows(21)} />);
    expect(region.scrollTop).toBe(1_784);
    region.scrollTop = 500;
    fireEvent.scroll(region);
    rerender(<MessageList {...options} messages={rows(22)} />);
    expect(region.scrollTop).toBe(500);
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest messages" }));
    expect(region.scrollTop).toBe(1_888);
    expect(document.activeElement).toBe(region);
  });
  it("preserves the reading anchor when a measured row above it changes height", () => {
    viewport();
    const callbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    render(<MessageList {...props(rows(20))} />);
    const region = screen.getByRole("region", { name: "Messages" });
    region.scrollTop = 500;
    fireEvent.scroll(region);
    const row = region.querySelector('[data-message-key="key-3"]');
    if (!row) throw new Error("Expected the overscanned row above the reading anchor.");
    act(() =>
      callbacks.at(-1)?.(
        [{ target: row, borderBoxSize: [{ blockSize: 208 }] } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      ),
    );
    expect(region.scrollTop).toBe(604);
  });
  it("batches polite announcements instead of making the entire message list live", async () => {
    vi.useFakeTimers();
    try {
      const options = props(rows(1));
      const { rerender, container } = render(<MessageList {...options} newMessageCount={0} />);
      rerender(<MessageList {...options} newMessageCount={5} />);
      rerender(<MessageList {...options} newMessageCount={10} />);
      expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe("");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe("10 new messages.");
      expect(screen.getByRole("list", { name: "Message history" }).hasAttribute("aria-live")).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("safe message rendering", () => {
  it("renders HTML and dangerous protocols as text and links only safe http URLs", () => {
    const { container } = render(
      <MessageBody
        body={
          "<img src=x onerror=alert(1)> javascript:alert(1) https://example.com/hello https://user:pass@example.com/"
        }
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://example.com/hello");
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
  });
  it("dedupes stored, optimistic and live rows by both identifiers", () => {
    const first = stored(1);
    expect(
      mergeMessages(
        [first],
        [first],
        [
          {
            payload: { channelId, body: first.body, clientMessageId: first.clientMessageId },
            status: "sending",
            attempts: 1,
            createdAt: first.createdAt,
          },
        ],
        testUser.id,
      ),
    ).toHaveLength(1);
  });
});
