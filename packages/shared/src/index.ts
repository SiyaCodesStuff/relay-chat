import { z } from "zod";

export const chatMessageSchema = z.object({
  roomId: z.string().uuid(),
  content: z.string().trim().min(1).max(2_000),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

export interface ServerToClientEvents {
  "chat:message": (message: ChatMessage) => void;
}

export interface ClientToServerEvents {
  "chat:send": (message: ChatMessage) => void;
}
