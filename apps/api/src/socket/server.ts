import type { Server as HttpServer } from "node:http";

import { Server as SocketServer, type Socket } from "socket.io";

import {
  SOCKET_NAMESPACE,
  SOCKET_SESSION_EXPIRED,
  SOCKET_SUBSCRIBE_EVENT,
  SOCKET_UNSUBSCRIBE_EVENT,
  SOCKET_CLIENT_EVENTS,
  SOCKET_EVENTS,
  CONNECTION_LIMIT_PER_MINUTE,
  REFRESH_MAX_INTERVAL_MS,
  SOCKET_EVENT_LIMIT_PER_MINUTE,
  TYPING_COALESCE_MS,
  conversationRoom,
  userRoom,
  failureEnvelope,
  successEnvelope,
  validateConversationSubscribePayload,
  validateSocketPayload,
} from "@chat/contracts";

import type { createVerifier } from "../auth/jwt.js";
import { getSessionForSensitive, type SessionLookup } from "../auth/session.js";
import { derivePrincipalWithRole, type Principal, type RoleLookup } from "../authz/principal.js";
import {
  authorizeSocketConversationJoin,
  authorizeSocketEvent,
  type SocketAuthorizer,
} from "../authz/index.js";

/**
 * Socket.IO foundation v0 (P1-09, INT-003/INT-004, DEC-019; hardened P2-08
 * for `FR-AUTH-007` and `FR-HIST-003` / `DEC-021` §7.4).
 *
 * - JWT/JWKS handshake: 5-min EdDSA token in `auth.token`, verified via
 *   the P1-06 verifier; `sid` session checked directly (no cache) on
 *   handshake and every `auth:refresh`.
 * - CORS: exact frontend origins only (`allowedOrigins`); missing/untrusted
 *   origin is rejected. No wildcard.
 * - `auth:refresh`: fresh token required at most every 5 min; failure emits
 *   `session:expired` and disconnects. Token expiry also emits
 *   `session:expired` and disconnects; the residual read window is bounded
 *   by the JWT lifetime and is not extended.
 * - Rooms: conversation rooms are joined only via `conversation:subscribe`
 *   (or legacy `join` alias) after active-session verification and CURRENT
 *   membership recheck (`conversationLookup`); denied resubscribes explicitly
 *   evict any stale room. Socket.IO recovery is disabled so persisted HTTP
 *   history remains the sole source of truth (`DEC-021` §7.4).
 * - Every protected inbound event rechecks authorization at event time via
 *   the P1-07 `authorizeSocketEvent` helpers; HTTP stays canonical for
 *   message sends (no second write path).
 * - Rate limits: 120 events/min/connection, typing coalesced to 1/2s,
 *   10 connections/min/user (per-process). Exceeded → `RATE_LIMITED` ack.
 * - Acks: every client event is acknowledged with a documented
 *   success/failure envelope (`requestId` + stable `code`). Denied events
 *   are never broadcast and never join a room.
 */
export interface SocketServerOptions {
  verifier: ReturnType<typeof createVerifier>;
  sessionLookup: SessionLookup;
  roleLookup?: RoleLookup;
  authorizer: SocketAuthorizer;
  /** Exact frontend origins allowed to open sockets. Empty → deny all. */
  allowedOrigins: string[];
  onReceipt?: (
    principal: Principal,
    payload: { schemaVersion: number; conversationId?: string; data?: Record<string, unknown> },
  ) => Promise<void> | void;
}

interface SocketData {
  principal?: Principal;
  tokenExpiresAt?: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
  eventTimes?: number[];
  lastTypingAt?: number;
}

function errorAck(
  code:
    | "UNAUTHENTICATED"
    | "SESSION_REVOKED"
    | "NOT_FOUND"
    | "FORBIDDEN"
    | "INVALID_REQUEST"
    | "RATE_LIMITED",
  message: string,
) {
  return failureEnvelope(code, message, code === "RATE_LIMITED");
}

function scheduleExpiry(socket: Socket, tokenExpiresAt: number): void {
  clearTimeout(socket.data.expiryTimer);
  const delay = Math.max(0, tokenExpiresAt - Date.now());
  socket.data.expiryTimer = setTimeout(() => {
    socket.emit(SOCKET_SESSION_EXPIRED, errorAck("SESSION_REVOKED", "Session expired."));
    socket.disconnect(true);
  }, delay);
  // Do not keep the process alive solely for an idle socket timer.
  if (typeof socket.data.expiryTimer === "object") {
    (socket.data.expiryTimer as { unref?: () => void }).unref?.();
  }
}

function checkEventLimit(socket: Socket): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  const times = (socket.data.eventTimes ?? []).filter((t: number) => t > windowStart);
  times.push(now);
  socket.data.eventTimes = times;
  return times.length <= SOCKET_EVENT_LIMIT_PER_MINUTE;
}

export function createSocketServer(
  httpServer: HttpServer,
  options: SocketServerOptions,
): SocketServer {
  const io = new SocketServer(httpServer, {
    path: "/socket.io",
    cors: {
      origin: (origin, callback) => {
        if (typeof origin === "string" && options.allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      methods: ["GET", "POST"],
      credentials: false,
    },
    maxHttpBufferSize: 32 * 1024,
  });

  const namespace = io.of(SOCKET_NAMESPACE);
  const connectionAttempts = new Map<string, number[]>();

  namespace.use(async (socket, next) => {
    const origin = socket.handshake.headers.origin;
    if (typeof origin !== "string" || !options.allowedOrigins.includes(origin)) {
      next(new Error("UNTRUSTED_ORIGIN"));
      return;
    }
    const auth = socket.handshake.auth as Record<string, unknown> | undefined;
    const token =
      (typeof auth?.token === "string" ? auth.token : null) ??
      (typeof socket.handshake.query?.token === "string"
        ? (socket.handshake.query.token as string)
        : null);
    if (!token) {
      next(new Error("UNAUTHENTICATED"));
      return;
    }
    try {
      const claims = await options.verifier(token);
      const session = await getSessionForSensitive(options.sessionLookup, claims.sid);
      const principal = await derivePrincipalWithRole(claims, session, options.roleLookup);
      if (!principal) {
        next(new Error("SESSION_REVOKED"));
        return;
      }
      if (!principal.emailVerified) {
        next(new Error("UNAUTHENTICATED"));
        return;
      }
      // Connection rate limit (DEC-016): 10/min/user, per-process.
      const now = Date.now();
      const attempts = (connectionAttempts.get(principal.userId) ?? []).filter(
        (t) => t > now - 60_000,
      );
      attempts.push(now);
      connectionAttempts.set(principal.userId, attempts);
      if (attempts.length > CONNECTION_LIMIT_PER_MINUTE) {
        next(new Error("RATE_LIMITED"));
        return;
      }
      (socket.data as SocketData).principal = principal;
      (socket.data as SocketData).tokenExpiresAt = claims.exp * 1000;
      next();
    } catch {
      next(new Error("UNAUTHENTICATED"));
    }
  });

  namespace.on("connection", (socket: Socket) => {
    const data = socket.data as SocketData;
    if (!data.principal) {
      socket.disconnect(true);
      return;
    }
    const { userId } = data.principal;
    void socket.join(userRoom(userId));
    scheduleExpiry(socket, data.tokenExpiresAt ?? Date.now() + REFRESH_MAX_INTERVAL_MS);
    socket.emit("connected", successEnvelope({ userId }));

    const principal = (): Principal | null => (socket.data as SocketData).principal ?? null;

    const expireAndDisconnect = (respond?: (body: unknown) => void) => {
      const ack = errorAck("SESSION_REVOKED", "Session is no longer valid.");
      respond?.(ack);
      clearTimeout((socket.data as SocketData).expiryTimer);
      socket.emit(
        SOCKET_SESSION_EXPIRED,
        errorAck("SESSION_REVOKED", "Session is no longer valid."),
      );
      socket.disconnect(true);
    };

    const ensureSocketSessionActive = async (): Promise<Principal | null> => {
      const socketData = socket.data as SocketData;
      const current = socketData.principal ?? null;
      if (!current || current.userId !== userId || !current.emailVerified) {
        return null;
      }
      if (
        typeof socketData.tokenExpiresAt === "number" &&
        socketData.tokenExpiresAt <= Date.now()
      ) {
        return null;
      }
      const session = await getSessionForSensitive(options.sessionLookup, current.sid);
      if (!session || session.revoked || session.userId !== userId) {
        return null;
      }
      return current;
    };

    socket.on("auth:refresh", async (payload: unknown, callback?: (body: unknown) => void) => {
      const respond = (body: unknown) => {
        if (typeof callback === "function") callback(body);
        else socket.emit("auth:refreshed", body);
      };
      if (!checkEventLimit(socket)) {
        respond(errorAck("RATE_LIMITED", "Event rate limit exceeded."));
        return;
      }
      const token =
        typeof payload === "string"
          ? payload
          : typeof (payload as Record<string, unknown> | null)?.token === "string"
            ? ((payload as Record<string, unknown>).token as string)
            : null;
      if (!token) {
        respond(errorAck("UNAUTHENTICATED", "A fresh token is required."));
        clearTimeout((socket.data as SocketData).expiryTimer);
        socket.emit(SOCKET_SESSION_EXPIRED, errorAck("SESSION_REVOKED", "Session expired."));
        socket.disconnect(true);
        return;
      }
      try {
        const claims = await options.verifier(token);
        const session = await getSessionForSensitive(options.sessionLookup, claims.sid);
        const refreshed = await derivePrincipalWithRole(claims, session, options.roleLookup);
        // Refresh must belong to the same verified user; a different user is a takeover.
        if (!refreshed || !refreshed.emailVerified || refreshed.userId !== userId) {
          expireAndDisconnect(respond);
          return;
        }
        (socket.data as SocketData).principal = refreshed;
        (socket.data as SocketData).tokenExpiresAt = claims.exp * 1000;
        scheduleExpiry(socket, claims.exp * 1000);
        respond(successEnvelope({ ok: true }));
      } catch {
        expireAndDisconnect(respond);
      }
    });

    const handleConversationSubscribe = async (
      payload: unknown,
      callback?: (body: unknown) => void,
    ) => {
      const respond = (body: unknown) => {
        if (typeof callback === "function") callback(body);
      };
      if (!checkEventLimit(socket)) {
        respond(errorAck("RATE_LIMITED", "Event rate limit exceeded."));
        return;
      }
      const validated = validateConversationSubscribePayload(payload);
      if (!validated.ok) {
        respond(failureEnvelope(validated.code, validated.message, validated.retryable));
        return;
      }
      const activePrincipal = await ensureSocketSessionActive();
      if (!activePrincipal) {
        expireAndDisconnect(respond);
        return;
      }
      const { conversationId } = validated.value;
      const result = await authorizeSocketConversationJoin(
        activePrincipal,
        conversationId,
        options.authorizer,
      );
      if (!result.ok) {
        await socket.leave(conversationRoom(conversationId));
        respond(
          failureEnvelope(result.denial.code, result.denial.message, result.denial.retryable),
        );
        return;
      }
      await socket.join(conversationRoom(conversationId));
      respond(successEnvelope({ conversationId, subscribed: true }));
    };

    const handleConversationUnsubscribe = async (
      payload: unknown,
      callback?: (body: unknown) => void,
    ) => {
      const respond = (body: unknown) => {
        if (typeof callback === "function") callback(body);
      };
      const validated = validateSocketPayload(payload);
      if (!validated.ok) {
        respond(failureEnvelope(validated.code, validated.message, validated.retryable));
        return;
      }
      const conversationId = validated.value.conversationId ?? null;
      if (conversationId) {
        await socket.leave(conversationRoom(conversationId));
      }
      respond(
        successEnvelope({
          ok: true,
          ...(conversationId ? { conversationId, subscribed: false } : {}),
        }),
      );
    };

    socket.on(SOCKET_SUBSCRIBE_EVENT, handleConversationSubscribe);
    socket.on("join", handleConversationSubscribe);
    socket.on(SOCKET_UNSUBSCRIBE_EVENT, handleConversationUnsubscribe);
    socket.on("leave", handleConversationUnsubscribe);

    socket.on("typing", async (payload: unknown, callback?: (body: unknown) => void) => {
      const respond = (body: unknown) => {
        if (typeof callback === "function") callback(body);
      };
      if (!checkEventLimit(socket)) {
        respond(errorAck("RATE_LIMITED", "Event rate limit exceeded."));
        return;
      }
      const now = Date.now();
      if (now - ((socket.data as SocketData).lastTypingAt ?? 0) < TYPING_COALESCE_MS) {
        respond(errorAck("RATE_LIMITED", "Typing signals are coalesced."));
        return;
      }
      const validated = validateSocketPayload(payload);
      if (!validated.ok) {
        respond(failureEnvelope(validated.code as never, validated.message, validated.retryable));
        return;
      }
      // Per-event authorization recheck (INT-004) at event time.
      const result = await authorizeSocketEvent(
        principal(),
        "typing:update",
        payload,
        options.authorizer,
      );
      if (!result.ok) {
        respond(
          failureEnvelope(result.denial.code, result.denial.message, result.denial.retryable),
        );
        return;
      }
      (socket.data as SocketData).lastTypingAt = now;
      const conversationId = validated.value.conversationId;
      if (conversationId) {
        socket.to(conversationRoom(conversationId)).emit("typing:update", validated.value);
      }
      respond(successEnvelope({ ok: true }));
    });

    socket.on("receipt", async (payload: unknown, callback?: (body: unknown) => void) => {
      const respond = (body: unknown) => {
        if (typeof callback === "function") callback(body);
      };
      if (!checkEventLimit(socket)) {
        respond(errorAck("RATE_LIMITED", "Event rate limit exceeded."));
        return;
      }
      const validated = validateSocketPayload(payload);
      if (!validated.ok) {
        respond(failureEnvelope(validated.code as never, validated.message, validated.retryable));
        return;
      }
      // Sensitive event: rechecks freshness + sender-only receipt (INT-004).
      const result = await authorizeSocketEvent(
        principal(),
        "message:receipt",
        payload,
        options.authorizer,
      );
      if (!result.ok) {
        respond(
          failureEnvelope(result.denial.code, result.denial.message, result.denial.retryable),
        );
        return;
      }
      const active = principal();
      if (!active) {
        respond(failureEnvelope("UNAUTHENTICATED", "Authentication required.", false));
        return;
      }
      if (options.onReceipt) {
        try {
          await options.onReceipt(active, validated.value);
        } catch {
          // Receipt hook failures must not break validated ack responses.
        }
      }
      respond(successEnvelope({ ok: true }));
    });

    socket.on("ping", (_payload: unknown, callback?: (body: unknown) => void) => {
      const respond = (body: unknown) => {
        if (typeof callback === "function") callback(body);
      };
      if (!checkEventLimit(socket)) {
        respond(errorAck("RATE_LIMITED", "Event rate limit exceeded."));
        return;
      }
      respond(successEnvelope({ ok: true }));
    });

    // Canonical write path is HTTP POST /api/v1/conversations/:id/messages (DEC-021 §3.1).
    // message:send is explicitly rejected and never persists or broadcasts.
    socket.on("message:send", (_payload: unknown, callback?: (body: unknown) => void) => {
      if (typeof callback === "function") {
        callback(
          failureEnvelope(
            "FORBIDDEN",
            "message:send is not supported; use HTTP POST /api/v1/conversations/:id/messages.",
            false,
          ),
        );
      }
    });

    // Guard: any other protected event name is denied without broadcast.
    // Server→client event names are never accepted inbound (fail-closed).
    for (const event of SOCKET_EVENTS) {
      socket.on(event, (_payload: unknown, callback?: (body: unknown) => void) => {
        const respond = (body: unknown) => {
          if (typeof callback === "function") callback(body);
        };
        respond(failureEnvelope("FORBIDDEN", "Server-to-client events are not accepted.", false));
      });
    }
    void SOCKET_CLIENT_EVENTS;

    socket.on("disconnect", () => {
      clearTimeout((socket.data as SocketData).expiryTimer);
      (socket.data as SocketData).eventTimes = undefined;
    });
  });

  return io;
}

/**
 * Best-effort immediate socket invalidation when a Better Auth session (`sid`)
 * is revoked (`DEC-019` §3.2, `FR-AUTH-007`). Emits `session:expired` and closes
 * matching connected `/v1` sockets without claiming instantaneous global JWT
 * revocation across stateless HTTP reads.
 */
export function disconnectRevokedSessionSockets(io: SocketServer, sid: string): number {
  const namespace = io.of(SOCKET_NAMESPACE);
  let disconnected = 0;
  for (const socket of namespace.sockets.values() as Iterable<Socket>) {
    const data = socket.data as SocketData;
    if (data.principal?.sid === sid) {
      clearTimeout(data.expiryTimer);
      socket.emit(SOCKET_SESSION_EXPIRED, errorAck("SESSION_REVOKED", "Session revoked."));
      socket.disconnect(true);
      disconnected += 1;
    }
  }
  return disconnected;
}

/**
 * Best-effort immediate socket invalidation for all sockets belonging to a user
 * after password reset, password change, email change, or account suspension
 * (`FR-AUTH-006`–`FR-AUTH-007`, `DEC-019` §3.2).
 */
export function disconnectRevokedUserSockets(io: SocketServer, userId: string): number {
  const namespace = io.of(SOCKET_NAMESPACE);
  let disconnected = 0;
  for (const socket of namespace.sockets.values() as Iterable<Socket>) {
    const data = socket.data as SocketData;
    if (data.principal?.userId === userId) {
      clearTimeout(data.expiryTimer);
      socket.emit(SOCKET_SESSION_EXPIRED, errorAck("SESSION_REVOKED", "Session revoked."));
      socket.disconnect(true);
      disconnected += 1;
    }
  }
  return disconnected;
}
