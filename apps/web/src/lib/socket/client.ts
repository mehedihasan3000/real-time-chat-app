import { io, type Socket } from "socket.io-client";

import { SOCKET_NAMESPACE } from "@chat/contracts";

/**
 * Browser socket client foundation v0 (P1-09, DEC-019).
 *
 * - Token is memory-only (a closure variable), never persisted to
 *   localStorage/sessionStorage/IndexedDB/cookies. It is cleared on
 *   disconnect.
 * - Fresh tokens come from `tokenProvider` (which queries
 *   `/api/auth/token` with the host-only session cookie).
 * - Reauthentication happens at most every 5 minutes (JWT max) and
 *   before expiry; `session:expired` disconnects and surfaces to the app.
 */
export interface SocketClientOptions {
  /** API socket origin, e.g. `https://api.example.com` or `http://127.0.0.1:3001`. */
  url: string;
  /** Returns a fresh 5-minute JWT, or null when the session is gone. */
  tokenProvider: () => Promise<string | null> | string | null;
  onExpired?: () => void;
}

export interface SocketClient {
  readonly socket: Socket;
  joinConversation: (conversationId: string) => Promise<unknown>;
  leaveConversation: (conversationId: string) => Promise<unknown>;
  sendTyping: (conversationId: string) => Promise<unknown>;
  disconnect: () => void;
}

interface AckResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string };
}

function emitWithAck(socket: Socket, event: string, payload: unknown): Promise<AckResult> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (body: AckResult) => resolve(body));
  });
}

export async function createSocketClient(options: SocketClientOptions): Promise<SocketClient> {
  let token: string | null = await options.tokenProvider();
  if (!token) {
    throw new Error("No session token available for socket connection.");
  }

  const socket = io(options.url + SOCKET_NAMESPACE, {
    auth: { token },
    transports: ["websocket", "polling"],
    autoConnect: false,
    reconnection: false,
  });

  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  const refresh = async (): Promise<void> => {
    const fresh = await options.tokenProvider();
    if (!fresh) {
      socket.disconnect();
      options.onExpired?.();
      return;
    }
    token = fresh;
    await emitWithAck(socket, "auth:refresh", { token: fresh });
  };

  socket.on("connect", () => {
    // Reauthenticate at most every 4 minutes (within the 5-minute JWT max).
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => void refresh(), 4 * 60 * 1000);
  });

  socket.on("session:expired", () => {
    token = null;
    if (refreshTimer) clearInterval(refreshTimer);
    options.onExpired?.();
    socket.disconnect();
  });

  socket.on("connect_error", () => {
    // Handshake failures surface via the connect_error event; callers
    // observe them and stay disconnected (fail-closed).
  });

  socket.connect();

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (error) => reject(error));
  });

  return {
    socket,
    joinConversation: (conversationId) =>
      emitWithAck(socket, "join", {
        schemaVersion: 1,
        conversationId,
        data: { conversationId },
      }),
    leaveConversation: (conversationId) =>
      emitWithAck(socket, "leave", {
        schemaVersion: 1,
        conversationId,
        data: { conversationId },
      }),
    sendTyping: (conversationId) =>
      emitWithAck(socket, "typing", {
        schemaVersion: 1,
        conversationId,
        data: { conversationId },
      }),
    disconnect: () => {
      token = null;
      if (refreshTimer) clearInterval(refreshTimer);
      socket.disconnect();
    },
  };
}
