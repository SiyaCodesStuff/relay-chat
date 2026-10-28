import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { App } from "../src/App.js";
import { AuthProvider } from "../src/auth/AuthProvider.js";
import { ErrorBoundary } from "../src/components/error-boundary.js";
import { apiOrigin, server, testUser } from "./server.js";

function renderApp(path = "/") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <ErrorBoundary>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </ErrorBoundary>,
  );
  return client;
}

async function fillLogin() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email"), "MEMBER@example.test");
  await user.type(screen.getByLabelText("Password"), "test-password-long");
  return user;
}

describe("web app smoke test", () => {
  it("protects the workspace and supplies a skip link", async () => {
    renderApp();
    expect(screen.getByRole("status").textContent).toBe("Checking your session…");
    // Session resolution and the router redirect are separate transitions.
    await waitFor(() => expect(screen.queryByText("Checking your session…")).toBeNull());
    expect(await screen.findByRole("heading", { name: "Sign in to Relay Chat" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Skip to main content" }).getAttribute("href")).toBe(
      "#main-content",
    );
    expect(document.activeElement?.id).toBe("main-content");
  });

  it("validates before submission, signs in with CSRF/credentials, and signs out", async () => {
    let loginCalls = 0;
    let logoutCalls = 0;
    server.use(
      http.post(`${apiOrigin}/api/v1/auth/login`, async ({ request }) => {
        loginCalls += 1;
        expect(request.headers.get("x-csrf-request")).toBe("1");
        expect(await request.json()).toMatchObject({ email: "member@example.test" });
        return HttpResponse.json({ user: testUser });
      }),
      http.post(`${apiOrigin}/api/v1/auth/logout`, ({ request }) => {
        logoutCalls += 1;
        expect(request.headers.get("x-csrf-request")).toBe("1");
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const client = renderApp();
    await screen.findByRole("heading", { name: "Sign in to Relay Chat" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter a valid email address.")).toBeTruthy();
    expect(loginCalls).toBe(0);
    await fillLogin();
    client.setQueryData(["private", "channels"], ["old cached data"]);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Welcome, River." })).toBeTruthy();
    expect(client.getQueryData(["private", "channels"])).toBeUndefined();
    expect(loginCalls).toBe(1);
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in to Relay Chat" })).toBeTruthy();
    expect(logoutCalls).toBe(1);
  });

  it("registers with a required display name and normalized email", async () => {
    server.use(
      http.post(`${apiOrigin}/api/v1/auth/register`, async ({ request }) => {
        expect(await request.json()).toMatchObject({
          displayName: "River",
          email: "member@example.test",
        });
        return HttpResponse.json({ user: testUser }, { status: 201 });
      }),
    );
    renderApp("/register");
    await screen.findByRole("heading", { name: "Create your account" });
    const user = await fillLogin();
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Enter your display name.")).toBeTruthy();
    await user.type(screen.getByLabelText("Display name"), "River");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("heading", { name: "Welcome, River." })).toBeTruthy();
  });

  it("shows identical login errors from the API without entering protected routes", async () => {
    server.use(
      http.post(`${apiOrigin}/api/v1/auth/login`, () =>
        HttpResponse.json({ error: "AUTHENTICATION_FAILED" }, { status: 401 }),
      ),
    );
    renderApp("/login");
    await screen.findByRole("heading", { name: "Sign in to Relay Chat" });
    const user = await fillLogin();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Email or password is incorrect.",
    );
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("restores the session and redirects authenticated users away from login", async () => {
    server.use(
      http.get(`${apiOrigin}/api/v1/auth/me`, () => {
        return HttpResponse.json({ user: testUser });
      }),
    );
    renderApp("/login");
    expect(await screen.findByRole("heading", { name: "Welcome, River." })).toBeTruthy();
  });

  it("surfaces session failures and lets the user try again", async () => {
    server.use(
      http.get(`${apiOrigin}/api/v1/auth/me`, () =>
        HttpResponse.json({ error: "INTERNAL_SERVER_ERROR" }, { status: 500 }),
      ),
    );
    renderApp();
    expect(
      await screen.findByRole("heading", { name: "Unable to check your session" }),
    ).toBeTruthy();
    server.use(
      http.get(`${apiOrigin}/api/v1/auth/me`, () => HttpResponse.json({ user: testUser })),
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Welcome, River." })).toBeTruthy();
  });

  it("toggles and persists the theme", async () => {
    renderApp("/login");
    await screen.findByRole("heading", { name: "Sign in to Relay Chat" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Dark theme" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("relay-theme")).toBe("dark");
    await userEvent.setup().click(screen.getByRole("button", { name: "Dark theme" }));
    expect(localStorage.getItem("relay-theme")).toBe("light");
  });

  it("keeps the session visible when logout fails", async () => {
    server.use(
      http.get(`${apiOrigin}/api/v1/auth/me`, () => HttpResponse.json({ user: testUser })),
      http.post(`${apiOrigin}/api/v1/auth/logout`, () =>
        HttpResponse.json({ error: "INTERNAL_SERVER_ERROR" }, { status: 503 }),
      ),
    );
    renderApp();
    await screen.findByRole("heading", { name: "Welcome, River." });
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Couldn’t sign out. Check your connection and try again.",
    );
    expect(screen.getByRole("heading", { name: "Welcome, River." })).toBeTruthy();
  });

  it("catches render failures without displaying internal error details", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Broken(): never {
      throw new Error("Internal implementation detail");
    }
    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
    expect(screen.queryByText("Internal implementation detail")).toBeNull();
  });
});
