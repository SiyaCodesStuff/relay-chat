import { z } from "zod";

export const chatMessageSchema = z.object({
  roomId: z.string().uuid(),
  content: z.string().trim().min(1).max(2_000),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

const emailSchema = z
  .string()
  .trim()
  .email()
  .max(320)
  .transform((email) => email.toLowerCase());
const passwordSchema = z.string().min(12).max(128);

export const registerRequestSchema = z.object({
  email: emailSchema,
  displayName: z.string().trim().min(1).max(80),
  password: passwordSchema,
});

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export interface ServerToClientEvents {
  "chat:message": (message: ChatMessage) => void;
}

export interface ClientToServerEvents {
  "chat:send": (message: ChatMessage) => void;
}
