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

const channelIdSchema = z.string().uuid();
const messageIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/i);

export const channelIdParamsSchema = z.object({
  channelId: channelIdSchema,
});

export const createChannelRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    isPrivate: z.boolean().default(false),
  })
  .strict();

export const listMessagesQuerySchema = z
  .object({
    before: messageIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const markChannelReadRequestSchema = z
  .object({
    messageId: messageIdSchema,
  })
  .strict();

export type CreateChannelRequest = z.infer<typeof createChannelRequestSchema>;
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
export type MarkChannelReadRequest = z.infer<typeof markChannelReadRequestSchema>;

export interface ServerToClientEvents {
  "chat:message": (message: ChatMessage) => void;
}

export interface ClientToServerEvents {
  "chat:send": (message: ChatMessage) => void;
}
