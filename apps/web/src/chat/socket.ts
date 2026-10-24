import { io, type ManagerOptions, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@relay-chat/shared";

export type ChatSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
export type ReconnectionOptions = Partial<
  Pick<ManagerOptions, "reconnectionDelay" | "reconnectionDelayMax" | "randomizationFactor">
>;
export type SocketFactory = (reconnection?: ReconnectionOptions) => ChatSocket;

export const createChatSocket: SocketFactory = (reconnection = {}) =>
  io({
    transports: ["websocket"],
    withCredentials: true,
    autoConnect: false,
    ...reconnection,
  });
