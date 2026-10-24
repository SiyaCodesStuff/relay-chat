import { z } from "zod";
import {
  apiErrorEnvelopeSchema,
  authResponseSchema,
  loginRequestSchema,
  registerRequestSchema,
  type LoginRequest,
  type RegisterRequest,
} from "@relay-chat/shared";

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(
      code === "AUTHENTICATION_FAILED"
        ? "Email or password is incorrect."
        : code === "REGISTRATION_FAILED"
          ? "Unable to create an account with these details."
          : code === "RATE_LIMITED"
            ? "Too many attempts. Please try again later."
            : code === "NETWORK_ERROR"
              ? "Unable to connect. Check your connection and try again."
              : "Something went wrong. Please try again.",
    );
    this.name = "ApiError";
  }
}

export async function request<T>(
  path: `/api/v1/${string}`,
  schema: z.ZodType<T>,
  options: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(new URL(path, window.location.origin), {
      method,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(method !== "GET" ? { "Content-Type": "application/json", "x-csrf-request": "1" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError("NETWORK_ERROR", 0);
  }
  const body: unknown =
    response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    const envelope = apiErrorEnvelopeSchema.safeParse(body);
    throw new ApiError(envelope.success ? envelope.data.error : "HTTP_ERROR", response.status);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError("INVALID_RESPONSE", response.status);
  return parsed.data;
}

export const authApi = {
  me: (signal?: AbortSignal) =>
    request("/api/v1/auth/me", authResponseSchema, signal ? { signal } : {}),
  login: (payload: LoginRequest) =>
    request("/api/v1/auth/login", authResponseSchema, {
      method: "POST",
      body: loginRequestSchema.parse(payload),
    }),
  register: (payload: RegisterRequest) =>
    request("/api/v1/auth/register", authResponseSchema, {
      method: "POST",
      body: registerRequestSchema.parse(payload),
    }),
  logout: () => request("/api/v1/auth/logout", z.undefined(), { method: "POST" }),
};
