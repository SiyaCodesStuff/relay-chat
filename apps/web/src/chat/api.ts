import { z } from "zod";
import { channelListResponseSchema, messageHistoryResponseSchema } from "@relay-chat/shared";
import { request } from "../lib/api.js";
export const chatApi = {
  channels: (signal?: AbortSignal) =>
    request("/api/v1/channels", channelListResponseSchema, signal ? { signal } : {}),
  history: (channelId: string, before: string | null = null, signal?: AbortSignal) =>
    request(
      `/api/v1/channels/${encodeURIComponent(channelId)}/messages?limit=50${before ? `&before=${encodeURIComponent(before)}` : ""}`,
      messageHistoryResponseSchema,
      signal ? { signal } : {},
    ),
  join: (channelId: string) =>
    request(`/api/v1/channels/${encodeURIComponent(channelId)}/join`, z.undefined(), {
      method: "POST",
    }),
  read: (channelId: string, messageId: string) =>
    request(`/api/v1/channels/${encodeURIComponent(channelId)}/read`, z.undefined(), {
      method: "POST",
      body: { messageId },
    }),
};
