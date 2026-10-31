import { test, expect } from "./fixtures.js";

test("two users join a channel, exchange live messages and see typing", async ({ chat }) => {
  const { alice, bob, pages, draft, send } = chat;
  await draft(alice).fill("Live from Alice");
  await expect(bob.getByLabel("Typing indicator")).toContainText("Someone is typing");
  await draft(alice).press("Enter");
  for (const page of pages)
    await expect(page.getByText("Live from Alice", { exact: true })).toHaveCount(1);
  await send(bob, "Live from Bob");
  await expect(alice.getByText("Live from Bob", { exact: true })).toHaveCount(1);
});

test("reconnect catches up missed messages once and preserves message order", async ({ chat }) => {
  const { alice, bob, pages, send, disconnectBob, reconnectBob } = chat;
  await send(alice, "Live from Alice");
  await expect(bob.getByText("Live from Alice", { exact: true })).toHaveCount(1);
  await send(bob, "Live from Bob");
  await expect(alice.getByText("Live from Bob", { exact: true })).toHaveCount(1);
  await disconnectBob();
  await send(alice, "Missed one");
  await send(alice, "Missed two");
  for (const body of ["Missed one", "Missed two"])
    await expect(bob.getByText(body, { exact: true })).toHaveCount(0);
  await reconnectBob();
  for (const page of pages) {
    for (const body of ["Live from Alice", "Live from Bob", "Missed one", "Missed two"])
      await expect(page.getByText(body, { exact: true })).toHaveCount(1);
    await expect(
      page.getByRole("list", { name: "Message history" }).locator("p.whitespace-pre-wrap"),
    ).toHaveText(["Live from Alice", "Live from Bob", "Missed one", "Missed two"]);
  }
});
