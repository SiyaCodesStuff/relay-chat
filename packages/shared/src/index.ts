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

export const messageSendSchema = z
  .object({
    channelId: channelIdSchema,
    body: z.string().trim().min(1).max(4_000),
    clientMessageId: z.string().trim().min(1).max(128),
  })
  .strict();

export const messageNewSchema = z.object({
  id: messageIdSchema,
  channelId: channelIdSchema,
  userId: z.string().uuid(),
  clientMessageId: z.string().min(1).max(128),
  body: z.string().min(1).max(4_000),
  createdAt: z.string().datetime({ offset: true }),
  editedAt: z.string().datetime({ offset: true }).nullable(),
});

export const channelJoinEventSchema = z
  .object({
    channelId: channelIdSchema,
  })
  .strict();

export const typingEventSchema = channelJoinEventSchema;
export const typingUpdateSchema = typingEventSchema.extend({ userId: z.string().uuid() });
export type TypingUpdate = z.infer<typeof typingUpdateSchema>;

export const presenceUpdateSchema = z.object({
  userId: z.string().uuid(),
  status: z.enum(["online", "offline"]),
});

export const socketErrorSchema = z.object({
  code: z.enum([
    "INVALID_PAYLOAD",
    "NOT_AUTHENTICATED",
    "NOT_A_MEMBER",
    "RATE_LIMITED",
    "INTERNAL_ERROR",
  ]),
});

export const socketActionAcknowledgementSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: socketErrorSchema }),
]);

export const messageSendAcknowledgementSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), message: messageNewSchema }),
  z.object({ ok: z.literal(false), error: socketErrorSchema }),
]);

export type MessageSend = z.infer<typeof messageSendSchema>;
export type MessageNew = z.infer<typeof messageNewSchema>;
export type ChannelJoinEvent = z.infer<typeof channelJoinEventSchema>;
export type TypingEvent = z.infer<typeof typingEventSchema>;
export type PresenceUpdate = z.infer<typeof presenceUpdateSchema>;
export type SocketError = z.infer<typeof socketErrorSchema>;
export type SocketActionAcknowledgement = z.infer<typeof socketActionAcknowledgementSchema>;
export type MessageSendAcknowledgement = z.infer<typeof messageSendAcknowledgementSchema>;

export const channelSyncSchema = z
  .object({
    channelId: channelIdSchema,
    after: messageIdSchema.nullable(),
    lastSeen: messageIdSchema.nullable().optional(),
  })
  .strict();
export const channelSyncAcknowledgementSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    messages: z.array(messageNewSchema).max(100),
    hasMore: z.boolean(),
  }),
  z.object({ ok: z.literal(false), error: socketErrorSchema }),
]);
export type ChannelSync = z.infer<typeof channelSyncSchema>;
export type ChannelSyncAcknowledgement = z.infer<typeof channelSyncAcknowledgementSchema>;

export interface ServerToClientEvents {
  "message:new": (message: MessageNew) => void;
  "typing:start": (event: TypingUpdate) => void;
  "typing:stop": (event: TypingUpdate) => void;
  "presence:update": (presence: PresenceUpdate) => void;
  error: (error: SocketError) => void;
}

export interface ClientToServerEvents {
  "channel:sync": (
    payload: ChannelSync,
    acknowledgement: (result: ChannelSyncAcknowledgement) => void,
  ) => void;
  "message:send": (
    message: MessageSend,
    acknowledgement: (result: MessageSendAcknowledgement) => void,
  ) => void;
  "channel:join": (
    channel: ChannelJoinEvent,
    acknowledgement: (result: SocketActionAcknowledgement) => void,
  ) => void;
  "typing:start": (event: TypingEvent) => void;
  "typing:stop": (event: TypingEvent) => void;
}

export { createReliableChatClient } from "./reliable-client.js";
export type { ReliableSocket, SendState } from "./reliable-client.js";
