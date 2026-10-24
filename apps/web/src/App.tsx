import { lazy, Suspense, useEffect, useRef } from "react";
import { Link, Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import { useAuth } from "./auth/AuthProvider.js";
import { AuthPage } from "./auth/AuthPage.js";
import { Button } from "./components/ui/button.js";
import { ThemeToggle } from "./components/theme-toggle.js";
const ChatScreen = lazy(() =>
  import("./chat/ChatScreen.js").then((module) => ({ default: module.ChatScreen })),
);

function ProtectedRoute() {
  const { user } = useAuth();
  const location = useLocation();
  return user ? (
    <Outlet />
  ) : (
    <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  );
}

export function App() {
  const { loading, error, refresh } = useAuth();
  const { pathname } = useLocation();
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    main.current?.focus();
  }, [pathname]);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        href="#main-content"
        className="sr-only z-50 rounded-lg bg-primary px-4 py-3 text-primary-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to main content
      </a>
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6 sm:px-10">
        <Link
          to="/"
          className="flex items-center gap-3 font-semibold tracking-tight"
          aria-label="Relay Chat home"
        >
          <span
            aria-hidden="true"
            className="flex size-9 items-center justify-center rounded-xl bg-primary text-lg text-primary-foreground"
          >
            r.
          </span>
          relay<span className="font-normal text-muted-foreground">chat</span>
        </Link>
        <ThemeToggle />
      </header>
      <main
        ref={main}
        id="main-content"
        tabIndex={-1}
        className={
          pathname === "/"
            ? "mx-auto h-[calc(100svh-100px)] max-w-6xl px-2 pb-3 outline-none sm:px-6"
            : "mx-auto flex min-h-[calc(100svh-100px)] max-w-6xl items-center justify-center px-6 py-12 outline-none sm:px-10"
        }
      >
        {loading ? (
          <p role="status">Checking your session…</p>
        ) : error ? (
          <section className="space-y-4">
            <h1 className="text-2xl font-semibold">Unable to check your session</h1>
            <p role="alert">Check your connection and try again.</p>
            <Button onClick={refresh}>Try again</Button>
          </section>
        ) : (
          <Routes>
            <Route path="/login" element={<AuthPage key="login" mode="login" />} />
            <Route path="/register" element={<AuthPage key="register" mode="register" />} />
            <Route element={<ProtectedRoute />}>
              <Route
                path="/"
                element={
                  <Suspense fallback={<p role="status">Opening your workspace…</p>}>
                    <ChatScreen />
                  </Suspense>
                }
              />
            </Route>
            <Route
              path="*"
              element={
                <section className="space-y-4">
                  <h1 className="text-2xl font-semibold">Page not found</h1>
                  <Link to="/" className="text-primary underline">
                    Back to Relay Chat
                  </Link>
                </section>
              }
            />
          </Routes>
        )}
      </main>
    </div>
  );
}
