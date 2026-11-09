import type { Server as HttpServer } from "node:http";
import { createServer } from "node:http";

import * as jose from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";

import { createApp } from "../../apps/api/src/app.js";
import { createVerifier, mintTestToken } from "../../apps/api/src/auth/jwt.js";
import { clearSessionCache } from "../../apps/api/src/auth/session.js";
import { createSocketServer } from "../../apps/api/src/socket/index.js";

const ISS = "http://127.0.0.1:3000";
const AUD = "http://127.0.0.1:3001";
const ALLOWED_ORIGIN = "http://127.0.0.1:3000";

let httpServer: HttpServer;
let originUrl: string;
let tokenA: string;
let tokenB: string;
let tokenExpired: string;
let shortTokenA: string;

let revoked = false;
let stale = false;

const conversationStore = new Map<string, { id: string; participantIds: string[] }>([
  ["conv-ab", { id: "conv-ab", participantIds: ["user-a", "user-b"] }],
  ["conv-cd", { id: "conv-cd", participantIds: ["user-c", "user-d"] }],
]);

function connect(token: string | null, origin = ALLOWED_ORIGIN): Socket {
  return io(`${originUrl}/v1`, {
    auth: { token },
    extraHeaders: { origin },
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
}

function waitConnect(socket: Socket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("connect timeout")), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitConnectError(socket: Socket, timeoutMs = 5000): Promise<Error> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("connect_error timeout")), timeoutMs);
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      resolve(error);
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      reject(new Error("expected connect_error"));
    });
  });
}

function emitAck(socket: Socket, event: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (body: unknown) => resolve(body));
  });
}

beforeAll(async () => {
  clearSessionCache();
  const keyPair = (await jose.generateKeyPair("Ed25519", {
    extractable: true,
  })) as unknown as {
    privateKey: import("jose").CryptoKey;
    publicKey: import("jose").CryptoKey;
    kid: string;
  };
  const shared = { ...keyPair, kid: "test-kid" };
  tokenA = (
    await mintTestToken({
      sub: "user-a",
      sid: "sid-a",
      emailVerified: true,
      iss: ISS,
      aud: AUD,
      keyPair: shared,
    })
  ).token;
  tokenB = (
    await mintTestToken({
      sub: "user-b",
      sid: "sid-b",
      emailVerified: true,
      iss: ISS,
      aud: AUD,
      keyPair: shared,
    })
  ).token;
  tokenExpired = (
    await mintTestToken({
      sub: "user-a",
      sid: "sid-a",
      emailVerified: true,
      iss: ISS,
      aud: AUD,
      expiresInSeconds: -10,
      keyPair: shared,
    })
  ).token;
  shortTokenA = (
    await mintTestToken({
      sub: "user-a",
      sid: "sid-a",
      emailVerified: true,
      iss: ISS,
      aud: AUD,
      expiresInSeconds: 3,
      keyPair: shared,
    })
  ).token;

  const verifier = createVerifier({
    appOrigin: ISS,
    apiOrigin: AUD,
    resolveKey: (async () => shared.publicKey as never) as never,
  });

  const app = createApp({
    verifier,
    sessionLookup: async (sid: string) => {
      if (sid === "sid-a") {
        if (revoked) {
          return { sid, userId: "user-a", revoked: true, authenticatedAt: new Date() };
        }
        if (stale) {
          return {
            sid,
            userId: "user-a",
            revoked: false,
            authenticatedAt: new Date(Date.now() - 20 * 60 * 1000),
          };
        }
        return { sid, userId: "user-a", revoked: false, authenticatedAt: new Date() };
      }
      if (sid === "sid-b") {
        return { sid, userId: "user-b", revoked: false, authenticatedAt: new Date() };
      }
      return null;
    },
  });
  httpServer = createServer(app);
  createSocketServer(httpServer, {
    verifier,
    sessionLookup: async (sid: string) => {
      if (sid === "sid-a") {
        if (revoked) {
          return { sid, userId: "user-a", revoked: true, authenticatedAt: new Date() };
        }
        if (stale) {
          return {
            sid,
            userId: "user-a",
            revoked: false,
            authenticatedAt: new Date(Date.now() - 20 * 60 * 1000),
          };
        }
        return { sid, userId: "user-a", revoked: false, authenticatedAt: new Date() };
      }
      if (sid === "sid-b") {
        return { sid, userId: "user-b", revoked: false, authenticatedAt: new Date() };
      }
      return null;
    },
    authorizer: {
      conversationLookup: async (id: string) => conversationStore.get(id) ?? null,
    },
    allowedOrigins: [ALLOWED_ORIGIN],
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
    httpServer.listen(0);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected ephemeral port.");
  originUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("P1-09 — invalid origins and credentials are rejected", () => {
  it("rejects an untrusted origin", async () => {
    const socket = connect(tokenA, "http://evil.example.com");
    const error = await waitConnectError(socket);
    expect(error.message).toBeTruthy();
    socket.disconnect();
  });

  it("rejects a missing token", async () => {
    const socket = connect(null);
    const error = await waitConnectError(socket);
    expect(error.message).toBeTruthy();
    socket.disconnect();
  });

  it("rejects an expired token", async () => {
    const socket = connect(tokenExpired);
    const error = await waitConnectError(socket);
    expect(error.message).toBeTruthy();
    socket.disconnect();
  });

  it("accepts a valid token from the allowed origin", async () => {
    const socket = connect(tokenA);
    await waitConnect(socket);
    expect(socket.connected).toBe(true);
    socket.disconnect();
  });
});

describe("P1-09 — protected events recheck membership", () => {
  it("allows joining an own conversation room and denies strangers", async () => {
    const socketA = connect(tokenA);
    await waitConnect(socketA);
    const own = await emitAck(socketA, "join", {
      schemaVersion: 1,
      conversationId: "conv-ab",
      data: { conversationId: "conv-ab" },
    });
    expect((own as { ok: boolean }).ok).toBe(true);

    const stranger = await emitAck(socketA, "join", {
      schemaVersion: 1,
      conversationId: "conv-cd",
      data: { conversationId: "conv-cd" },
    });
    expect(stranger).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    socketA.disconnect();

    const socketB = connect(tokenB);
    await waitConnect(socketB);
    const joined = await emitAck(socketB, "join", {
      schemaVersion: 1,
      conversationId: "conv-ab",
      data: { conversationId: "conv-ab" },
    });
    expect((joined as { ok: boolean }).ok).toBe(true);
    socketB.disconnect();
  });

  it("denies a stale room after membership removal", async () => {
    const socket = connect(tokenA);
    await waitConnect(socket);
    conversationStore.set("conv-ab", { id: "conv-ab", participantIds: ["user-b"] });
    const staleJoin = await emitAck(socket, "join", {
      schemaVersion: 1,
      conversationId: "conv-ab",
      data: { conversationId: "conv-ab" },
    });
    expect(staleJoin).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    conversationStore.set("conv-ab", { id: "conv-ab", participantIds: ["user-a", "user-b"] });
    socket.disconnect();
  });
});

describe("P1-09 — revoked sessions fail refresh and sensitive events", () => {
  it("fails auth:refresh after revocation and disconnects with session:expired", async () => {
    const socket = connect(tokenA);
    await waitConnect(socket);
    revoked = true;
    const expiredSeen = new Promise<void>((resolve) => {
      socket.once("session:expired", () => resolve());
    });
    const result = await emitAck(socket, "auth:refresh", { token: tokenA });
    expect(result).toMatchObject({ ok: false, error: { code: "SESSION_REVOKED" } });
    await expiredSeen;
    expect(socket.connected).toBe(false);
    revoked = false;
  });

  it("fails sensitive receipt events on a stale (non-fresh) session", async () => {
    const socket = connect(tokenA);
    await waitConnect(socket);
    stale = true;
    // Re-derive the principal state by refreshing into staleness: the
    // handshake principal was fresh, so flip then refresh with the same
    // token to re-derive a stale principal.
    const refreshResult = await emitAck(socket, "auth:refresh", { token: tokenA });
    expect((refreshResult as { ok: boolean }).ok).toBe(true);
    const receipt = await emitAck(socket, "receipt", {
      schemaVersion: 1,
      conversationId: "conv-ab",
      data: { messageId: "msg-1" },
    });
    expect(receipt).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    stale = false;
    socket.disconnect();
  });
});

describe("P1-09 — expiry invalidates actions", () => {
  it("disconnects a socket when its token expires without refresh", async () => {
    const socket = connect(shortTokenA);
    await waitConnect(socket);
    const expired = new Promise<void>((resolve) => {
      socket.once("session:expired", () => resolve());
    });
    // Cover the refresh interval: expiry timer fires at ~3s.
    const pingOk = (await emitAck(socket, "ping", {})) as { ok: boolean };
    expect(pingOk.ok).toBe(true);
    await expired;
    expect(socket.connected).toBe(false);
    socket.disconnect();
  }, 15000);
});
