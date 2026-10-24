import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { loginRequestSchema } from "@relay-chat/shared";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { useAuth } from "./AuthProvider.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { ApiError } from "../lib/api.js";

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const isRegister = mode === "register";
  const schema = loginRequestSchema
    .extend({ displayName: z.string().trim().max(80).optional() })
    .superRefine((value, context) => {
      if (isRegister && !value.displayName)
        context.addIssue({
          code: "custom",
          path: ["displayName"],
          message: "Enter your display name.",
        });
    });
  type Fields = z.infer<typeof schema>;
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Fields>({ resolver: zodResolver(schema), shouldFocusError: true });
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const state: unknown = location.state;
  const from =
    typeof state === "object" &&
    state !== null &&
    "from" in state &&
    typeof state.from === "string" &&
    state.from.startsWith("/") &&
    !state.from.startsWith("//") &&
    !state.from.startsWith("/login") &&
    !state.from.startsWith("/register")
      ? state.from
      : "/";
  if (auth.user) return <Navigate to={from} replace />;

  const submit = handleSubmit(async (values) => {
    try {
      if (isRegister)
        await auth.register({
          email: values.email,
          password: values.password,
          displayName: values.displayName ?? "",
        });
      else await auth.login({ email: values.email, password: values.password });
      navigate(from, { replace: true });
    } catch (error) {
      setError("root", {
        message:
          error instanceof ApiError ? error.message : "Unable to continue. Please try again.",
      });
    }
  });

  return (
    <div className="grid w-full items-center gap-14 lg:grid-cols-2 lg:gap-24">
      <section className="hidden max-w-md lg:block" aria-labelledby="intro-title">
        <p className="mb-6 text-xs font-semibold uppercase tracking-[0.2em] text-primary">
          A little closer, in real time
        </p>
        <h2 id="intro-title" className="text-5xl leading-[1.1] font-semibold tracking-tight">
          Good conversations
          <br />
          start with hello.
        </h2>
        <p className="mt-6 text-lg leading-relaxed text-muted-foreground">
          A shared space for your team. Find your people, pick up a conversation, and keep things
          moving.
        </p>
        <div
          aria-hidden="true"
          className="mt-10 rounded-2xl border border-border bg-card p-6 shadow-sm"
        >
          <div className="flex gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
              R
            </span>
            <div>
              <p className="text-sm font-medium">
                A place to connect{" "}
                <span className="ml-2 text-xs font-normal text-muted-foreground">now</span>
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Less distance. More conversation.
              </p>
            </div>
          </div>
          <div className="mt-5 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="size-2 rounded-full bg-primary" />
            Ready when you are
          </div>
        </div>
      </section>
      <section
        className="mx-auto w-full max-w-md rounded-2xl border border-border bg-card p-7 shadow-sm sm:p-10"
        aria-labelledby="auth-title"
      >
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-primary">
          {isRegister ? "Join the conversation" : "Welcome back"}
        </p>
        <h1 id="auth-title" className="text-3xl font-semibold tracking-tight">
          {isRegister ? "Create your account" : "Sign in to Relay Chat"}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {isRegister
            ? "Make yourself at home. Your team is just a hello away."
            : "Your people and conversations are right here."}
        </p>
        <form onSubmit={submit} noValidate aria-busy={isSubmitting} className="mt-8 space-y-5">
          {isRegister && (
            <div className="space-y-2">
              <label htmlFor="display-name" className="text-sm font-medium">
                Display name
              </label>
              <Input
                id="display-name"
                required
                autoComplete="nickname"
                maxLength={80}
                aria-invalid={Boolean(errors.displayName)}
                aria-describedby={errors.displayName ? "display-name-error" : undefined}
                {...register("displayName")}
              />
              {errors.displayName && (
                <p id="display-name-error" role="alert" className="text-sm text-destructive">
                  {errors.displayName.message}
                </p>
              )}
            </div>
          )}
          <div className="space-y-2">
            <label htmlFor="email" className="text-sm font-medium">
              Email
            </label>
            <Input
              id="email"
              required
              type="email"
              autoComplete="email"
              maxLength={320}
              placeholder="you@example.com"
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? "email-error" : undefined}
              {...register("email")}
            />
            {errors.email && (
              <p id="email-error" role="alert" className="text-sm text-destructive">
                Enter a valid email address.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <Input
              id="password"
              required
              type="password"
              autoComplete={isRegister ? "new-password" : "current-password"}
              minLength={12}
              maxLength={128}
              aria-invalid={Boolean(errors.password)}
              aria-describedby="password-help"
              {...register("password")}
            />
            <p
              id="password-help"
              role={errors.password ? "alert" : undefined}
              className={
                errors.password ? "text-sm text-destructive" : "text-xs text-muted-foreground"
              }
            >
              Use between 12 and 128 characters.
            </p>
          </div>
          {errors.root && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {errors.root.message}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Please wait…" : isRegister ? "Create account" : "Sign in"}
          </Button>
        </form>
        <p className="mt-6 text-center text-sm text-muted-foreground">
          {isRegister ? "Already part of the conversation?" : "New around here?"}{" "}
          <Link
            className="font-medium text-primary underline-offset-4 hover:underline"
            to={isRegister ? "/login" : "/register"}
          >
            {isRegister ? "Sign in" : "Create an account"}
          </Link>
        </p>
      </section>
    </div>
  );
}
