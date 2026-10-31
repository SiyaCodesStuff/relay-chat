import type { Page } from "@playwright/test";
import { sessionCookieName } from "../apps/api/src/auth/session.js";
import { test, expect, markupDisplayName } from "./fixtures.js";

const payloads = [
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  "[x](javascript:alert(1))",
];

async function expectNoExecutableMarkup(page: Page) {
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(
    await page
      .locator("script")
      .evaluateAll((scripts) => scripts.some((script) => script.textContent?.includes("alert(1)"))),
  ).toBe(false);
  await expect(page.locator('a[href^="javascript:" i]')).toHaveCount(0);
}

test("XSS message payloads stay literal for another user live and after reload", async ({
  chat,
}) => {
  const { alice, bob, send, selectChannel, dialogs } = chat;
  for (const payload of payloads) {
    await send(alice, payload);
    await expect(
      bob.getByRole("list", { name: "Message history" }).getByText(payload, { exact: true }),
    ).toHaveCount(1);
    await expectNoExecutableMarkup(bob);
    expect(dialogs.count).toBe(0);
  }
  await bob.reload();
  await selectChannel(bob);
  await expect(
    bob.getByRole("list", { name: "Message history" }).locator("p.whitespace-pre-wrap"),
  ).toHaveText(payloads);
  await expectNoExecutableMarkup(bob);
  expect(dialogs.count).toBe(0);
});

test("a display name containing HTML stays literal before and after reload", async ({ chat }) => {
  const { bob, dialogs } = chat;
  const heading = bob.getByRole("heading", { name: `Welcome, ${markupDisplayName}.`, exact: true });
  await expect(heading).toBeVisible();
  await expectNoExecutableMarkup(bob);
  expect(dialogs.count).toBe(0);
  await bob.reload();
  await expect(heading).toBeVisible();
  await expectNoExecutableMarkup(bob);
  expect(dialogs.count).toBe(0);
});

test("separate users keep distinct HttpOnly sessions hidden from document.cookie after reload", async ({
  chat,
}) => {
  const sessionValues: string[] = [];
  for (const [index, page] of chat.pages.entries()) {
    for (const reloaded of [false, true]) {
      if (reloaded) await page.reload();
      await expect(
        page.getByRole("heading", {
          name: `Welcome, ${index === 0 ? "E2E Alice" : markupDisplayName}.`,
          exact: true,
        }),
      ).toBeVisible();
      const cookie = (await page.context().cookies()).find(
        (entry) => entry.name === sessionCookieName,
      );
      // Failure output must never contain session values: assert booleans and flags only.
      expect(Boolean(cookie), "session cookie exists").toBe(true);
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.sameSite).toBe("Lax");
      const exposed = await page.evaluate(() => document.cookie);
      expect(Boolean(cookie && exposed.includes(cookie.value)), "session value is hidden").toBe(
        false,
      );
      expect(
        exposed.split(";").some((entry) => entry.trim().startsWith(`${sessionCookieName}=`)),
        "session name is hidden",
      ).toBe(false);
      if (!reloaded && cookie) sessionValues.push(cookie.value);
    }
  }
  expect(sessionValues.length).toBe(2);
  expect(sessionValues[0] === sessionValues[1], "contexts have separate sessions").toBe(false);
});
