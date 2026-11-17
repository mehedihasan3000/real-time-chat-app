import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { io as ioClient, type Socket } from "socket.io-client";
import {
  CONVERSATION_FORBIDDEN_FIELDS,
  PUBLIC_FIELDS,
  hasOnlyFields,
  type ConversationSummary,
} from "@chat/contracts";
import { createApp } from "../../apps/api/src/app.js";
import { createVerifier, mintTestToken } from "../../apps/api/src/auth/jwt.js";
import { clearSessionCache, type SessionRecord } from "../../apps/api/src/auth/session.js";
import { MemoryBlockStore } from "../../apps/api/src/blocks/store.js";
import {
  ConversationRateLimiter,
  MemoryConversationStore,
} from "../../apps/api/src/conversations/index.js";
import { MemoryProfileStore, type ProfileRecord } from "../../apps/api/src/profiles/store.js";
import { createSocketServer } from "../../apps/api/src/socket/server.js";
import {
  ConversationsClient,
  mapConversationOpenError,
  toConversationOpenReadyState,
} from "../../apps/web/src/features/chat/index.js";

const ISS = "https://app.example.test";
const AUD = "https://api.example.test";

interface EnvelopeBody<T = unknown> {
  ok: boolean;
  requestId: string;
  data?: T;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

let server: Server;
let ioServer: ReturnType<typeof createSocketServer> | null = null;
let baseUrl = "";

let keyPair!: Awaited<ReturnType<typeof mintTestToken>>["keyPair"];
let tokens = new Map<string, string>();
let sessions = new Map<string, SessionRecord>();
let profileMap = new Map<string, ProfileRecord>();
let eligibleUsers = new Set<string>();
let currentNow = new Date("2026-02-01T12:00:00.000Z");

let blockStore = new MemoryBlockStore();
let conversationStore = new MemoryConversationStore();
let rateLimiter = new ConversationRateLimiter();

function tok(userId: string): string {
  const token = tokens.get(userId);
  if (!token) throw new Error(`Missing test token for ${userId}`);
  return token;
}

function makeProfile(userId: string, username: string, displayName: string): ProfileRecord {
  return {
    userId,
    username,
    displayName,
    avatar: null,
    locale: "en",
    timeZone: "UTC",
  };
}

async function seedUser(
  userId: string,
  sid: string,
  opts: {
    emailVerified?: boolean;
    eligible?: boolean;
    withProfile?: boolean;
    authenticatedAt?: Date;
    revoked?: boolean;
    expiresInSeconds?: number;
  } = {},
) {
  const minted = await mintTestToken({
    sub: userId,
    sid,
    emailVerified: opts.emailVerified ?? true,
    iss: ISS,
    aud: AUD,
    expiresInSeconds: opts.expiresInSeconds,
    keyPair,
  });
  tokens.set(userId, minted.token);
  sessions.set(sid, {
    sid,
    userId,
    revoked: opts.revoked ?? false,
    authenticatedAt: opts.authenticatedAt ?? new Date(),
  });
  if (opts.eligible ?? true) {
    eligibleUsers.add(userId);
  } else {
    eligibleUsers.delete(userId);
  }
  if (opts.withProfile ?? true) {
    profileMap.set(userId, makeProfile(userId, userId.replace(/-/g, "_"), `Synthetic ${userId}`));
  }
}

async function apiReq<T = unknown>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<{ status: number; headers: Headers; body: EnvelopeBody<T> }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.body !== undefined && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const body = (await res.json()) as EnvelopeBody<T>;
  return { status: res.status, headers: res.headers, body };
}

function assertCleanSummary(summary: ConversationSummary) {
  expect(hasOnlyFields(summary, PUBLIC_FIELDS.conversationSummary)).toBe(true);
  expect(hasOnlyFields(summary.peer, PUBLIC_FIELDS.conversationPeer)).toBe(true);
  expect(summary.participantIds).toHaveLength(2);
  expect(summary.participantIds[0]).not.toBe(summary.participantIds[1]);
  const rawJson = JSON.stringify(summary);
  for (const forbidden of CONVERSATION_FORBIDDEN_FIELDS) {
    expect(Object.prototype.hasOwnProperty.call(summary, forbidden)).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(summary.peer, forbidden)).toBe(false);
  }
  expect(rawJson).not.toContain("@");
}

function waitConnect(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (err) => reject(err));
  });
}

function emitAck(socket: Socket, event: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (response: unknown) => resolve(response));
  });
}

beforeAll(async () => {
  const seeded = await mintTestToken({
    sub: "seed",
    sid: "sid-seed",
    emailVerified: true,
    iss: ISS,
    aud: AUD,
  });
  keyPair = seeded.keyPair;

  const verifier = createVerifier({
    appOrigin: ISS,
    apiOrigin: AUD,
    resolveKey: (async () => keyPair.publicKey as never) as never,
  });

  const backingProfileStore = new MemoryProfileStore();
  const profileStoreProxy: MemoryProfileStore = Object.assign(
    Object.create(Object.getPrototypeOf(backingProfileStore)),
    backingProfileStore,
    {
      async getByUserId(userId: string) {
        return profileMap.get(userId) ?? null;
      },
    },
  );

  const blockStoreProxy = new Proxy(blockStore, {
    get(_target, prop) {
      const val = Reflect.get(blockStore, prop, blockStore);
      return typeof val === "function" ? val.bind(blockStore) : val;
    },
  });
  const conversationStoreProxy = new Proxy(conversationStore, {
    get(_target, prop) {
      const val = Reflect.get(conversationStore, prop, conversationStore);
      return typeof val === "function" ? val.bind(conversationStore) : val;
    },
  });
  const rateLimiterProxy = new Proxy(rateLimiter, {
    get(_target, prop) {
      const val = Reflect.get(rateLimiter, prop, rateLimiter);
      return typeof val === "function" ? val.bind(rateLimiter) : val;
    },
  });

  const app = createApp({
    verifier,
    sessionLookup: async (sid) => sessions.get(sid) ?? null,
    profileStore: profileStoreProxy,
    blockStore: blockStoreProxy,
    conversationStore: conversationStoreProxy,
    conversationRateLimiter: rateLimiterProxy,
    userEligibilityLookup: async (userId) => eligibleUsers.has(userId),
    now: () => currentNow,
  });

  server = createServer(app);
  ioServer = createSocketServer(server, {
    verifier,
    sessionLookup: async (sid) => sessions.get(sid) ?? null,
    authorizer: {
      conversationLookup: async (id) => conversationStoreProxy.getById(id),
    },
    allowedOrigins: [ISS],
  });

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Expected TCP address.");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await ioServer?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  clearSessionCache();
  tokens = new Map();
  sessions = new Map();
  profileMap = new Map();
  eligibleUsers = new Set();
  currentNow = new Date("2026-02-01T12:00:00.000Z");
  blockStore = new MemoryBlockStore();
  conversationStore = new MemoryConversationStore();
  rateLimiter = new ConversationRateLimiter();

  await seedUser("user-a", "sid-a");
  await seedUser("user-b", "sid-b");
  await seedUser("user-c", "sid-c");
  await seedUser("user-d", "sid-d");
  await seedUser("user-unverified", "sid-unv", { emailVerified: false });
  await seedUser("user-suspended", "sid-sus", { eligible: false });
});

describe("P2-03 integration — TC-CHAT-001 create/list idempotency, concurrency, isolation", () => {
  it("creates one immutable direct conversation per pair regardless of caller order or concurrency", async () => {
    const createAB = await apiReq<{ conversation: ConversationSummary; created: boolean }>(
      "/api/v1/conversations",
      tok("user-a"),
      {
        method: "POST",
        body: JSON.stringify({ schemaVersion: 1, peerUserId: "user-b" }),
      },
    );
    expect(createAB.status).toBe(201);
    expect(createAB.body.ok).toBe(true);
    const convA = createAB.body.data!.conversation;
    expect(createAB.body.data!.created).toBe(true);
    expect(convA.participantIds).toEqual(["user-a", "user-b"]);
    expect(convA.peer.userId).toBe("user-b");
    expect(convA.lastSeq).toBe(0);
    expect(convA.blockedByViewer).toBe(false);
    assertCleanSummary(convA);

    // Reverse caller gets the same conversation with created: false.
    const getBA = await apiReq<{ conversation: ConversationSummary; created: boolean }>(
      "/api/v1/conversations",
      tok("user-b"),
      {
        method: "POST",
        body: JSON.stringify({ schemaVersion: 1, peerUserId: "user-a" }),
      },
    );
    expect(getBA.status).toBe(200);
    expect(getBA.body.data!.created).toBe(false);
    expect(getBA.body.data!.conversation.id).toBe(convA.id);
    expect(getBA.body.data!.conversation.peer.userId).toBe("user-a");
    assertCleanSummary(getBA.body.data!.conversation);

    // True concurrent HTTP requests between A and C converge on one canonical ID.
    const parallel = await Promise.all([
      apiReq<{ conversation: ConversationSummary; created: boolean }>(
        "/api/v1/conversations",
        tok("user-a"),
        { method: "POST", body: JSON.stringify({ schemaVersion: 1, peerUserId: "user-c" }) },
      ),
      apiReq<{ conversation: ConversationSummary; created: boolean }>(
        "/api/v1/conversations",
        tok("user-c"),
        { method: "POST", body: JSON.stringify({ schemaVersion: 1, peerUserId: "user-a" }) },
      ),
      apiReq<{ conversation: ConversationSummary; created: boolean }>(
        "/api/v1/conversations",
        tok("user-a"),
        { method: "POST", body: JSON.stringify({ schemaVersion: 1, peerUserId: "user-c" }) },
      ),
    ]);
    const parallelIds = new Set(parallel.map((r) => r.body.data!.conversation.id));
    expect(parallelIds.size).toBe(1);
    expect(parallel.filter((r) => r.body.data!.created)).toHaveLength(1);
    expect(parallel.filter((r) => !r.body.data!.created)).toHaveLength(2);

    const listC = await apiReq<{ items: ConversationSummary[] }>(
      "/api/v1/conversations",
      tok("user-c"),
    );
    expect(listC.status).toBe(200);
    expect(listC.body.data!.items).toHaveLength(1);
    expect(listC.body.data!.items[0]!.id).toBe([...parallelIds][0]);
  });

  it("blocks third participants, self-chats, and unauthorized strangers uniformly across HTTP & Socket.IO", async () => {
    const createAB = await apiReq<{ conversation: ConversationSummary; created: boolean }>(
      "/api/v1/conversations",
      tok("user-a"),
      {
        method: "POST",
        body: JSON.stringify({ schemaVersion: 1, peerUserId: "user-b" }),
      },
    );
    const abId = createAB.body.data!.conversation.id;

    // Client attempts to inject extra participant or override fields.
    for (const badBody of [
      { schemaVersion: 1, peerUserId: "user-b", participantIds: ["user-a", "user-b", "user-c"] },
      { schemaVersion: 1, peerUserId: "user-b", blockedByViewer: true },
      { schemaVersion: 1, peerUserId: "user-b", pairKey: "user-a:user-c" },
      { schemaVersion: 1, peerUserId: "user-a" },
      { schemaVersion: 1, peerUserId: "user:b" },
      { schemaVersion: 1, peerUserId: { $ne: "" } },
    ]) {
      const res = await apiReq("/api/v1/conversations", tok("user-a"), {
        method: "POST",
        body: JSON.stringify(badBody),
      });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("INVALID_REQUEST");
    }

    const badVer = await apiReq("/api/v1/conversations", tok("user-a"), {
      method: "POST",
      body: JSON.stringify({ schemaVersion: 99, peerUserId: "user-b" }),
    });
    expect(badVer.status).toBe(422);
    expect(badVer.body.error?.code).toBe("UNSUPPORTED_SCHEMA_VERSION");

    // Unrelated user D gets empty list and uniform 404 NOT_FOUND on HTTP detail, history, and Socket join.
    const listD = await apiReq<{ items: ConversationSummary[] }>(
      "/api/v1/conversations",
      tok("user-d"),
    );
    expect(listD.status).toBe(200);
    expect(listD.body.data).toEqual({ items: [], nextCursor: null, hasMore: false });

    const strangerDetail = await apiReq(`/api/v1/conversations/${abId}`, tok("user-d"));
    const missingDetail = await apiReq("/api/v1/conversations/conv_missing_id", tok("user-d"));
    expect(strangerDetail.status).toBe(404);
    expect(missingDetail.status).toBe(404);
    expect(strangerDetail.body.error?.code).toBe("NOT_FOUND");
    expect(missingDetail.body.error?.code).toBe("NOT_FOUND");
    expect(strangerDetail.body.error?.message).toBe(missingDetail.body.error?.message);

    const strangerMsgs = await apiReq(`/api/v1/conversations/${abId}/messages`, tok("user-d"));
    expect(strangerMsgs.status).toBe(404);
    expect(strangerMsgs.body.error?.code).toBe("NOT_FOUND");

    // Participant A reads single thread cleanly.
    const ownerDetail = await apiReq<{ conversation: ConversationSummary }>(
      `/api/v1/conversations/${abId}`,
      tok("user-a"),
    );
    expect(ownerDetail.status).toBe(200);
    expect(ownerDetail.body.data!.conversation.id).toBe(abId);

    // Socket.IO /v1 namespace join allows participant A/B and rejects unrelated user D identically to missing ID.
    const sockD = ioClient(`${baseUrl}/v1`, {
      auth: { token: tok("user-d") },
      extraHeaders: { origin: ISS },
      reconnection: false,
      transports: ["websocket"],
    });
    try {
      await waitConnect(sockD);
      const sockJoinOther = await emitAck(sockD, "join", {
        schemaVersion: 1,
        conversationId: abId,
        data: { conversationId: abId },
      });
      const sockJoinMissing = await emitAck(sockD, "join", {
        schemaVersion: 1,
        conversationId: "conv_missing_id",
        data: { conversationId: "conv_missing_id" },
      });
      expect(sockJoinOther).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      expect((sockJoinMissing as EnvelopeBody).ok).toBe(false);
      expect((sockJoinMissing as EnvelopeBody).error).toEqual(
        (sockJoinOther as EnvelopeBody).error,
      );
    } finally {
      sockD.disconnect();
    }

    const sockA = ioClient(`${baseUrl}/v1`, {
      auth: { token: tok("user-a") },
      extraHeaders: { origin: ISS },
      reconnection: false,
      transports: ["websocket"],
    });
    try {
      await waitConnect(sockA);
      const sockJoinOwn = await emitAck(sockA, "join", {
        schemaVersion: 1,
        conversationId: abId,
        data: { conversationId: abId },
      });
      expect(sockJoinOwn).toMatchObject({ ok: true });
    } finally {
      sockA.disconnect();
    }
  });
});

describe("P2-03 integration — TC-PRIV-003 silent bilateral blocking, auth/tombstone, pagination & rate limits", () => {
  it("enforces silent blocking on create without leaking block state to blocked peer", async () => {
    const aBlocksD = await apiReq("/api/v1/blocks", tok("user-a"), {
      method: "POST",
      body: JSON.stringify({ schemaVersion: 1, blockedUserId: "user-d" }),
    });
    expect([200, 201]).toContain(aBlocksD.status);

    // Blocked D receives generic 404 USER_UNAVAILABLE — indistinguishable from missing/suspended user.
    const blockedCreate = await apiReq("/api/v1/conversations", tok("user-d"), {
      method: "POST",
      body: JSON.stringify({ schemaVersion: 1, peerUserId: "user-a" }),
    });
    const missingUserCreate = await apiReq("/api/v1/conversations", tok("user-d"), {
      method: "POST",
      body: JSON.stringify({ schemaVersion: 1, peerUserId: "user-unknown" }),
    });
    const suspendedUserCreate = await apiReq("/api/v1/conversations", tok("user-d"), {
      method: "POST",
      body: JSON.stringify({ schemaVersion: 1, peerUserId: "user-suspended" }),
    });
    expect(blockedCreate.status).toBe(404);
    expect(blockedCreate.body.error?.code).toBe("USER_UNAVAILABLE");
    expect(blockedCreate.body.error?.message).toBe(missingUserCreate.body.error?.message);
    expect(blockedCreate.body.error?.message).toBe(suspendedUserCreate.body.error?.message);
    expect(blockedCreate.body.error?.message.toLowerCase()).not.toContain("block");

    // Blocker A receives explicit 403 BLOCKED (depends only on A's own block list).
    const blockerCreate = await apiReq("/api/v1/conversations", tok("user-a"), {
      method: "POST",
      body: JSON.stringify({ schemaVersion: 1, peerUserId: "user-d" }),
    });
    expect(blockerCreate.status).toBe(403);
    expect(blockerCreate.body.error?.code).toBe("BLOCKED");

    // Even under mutual block, A still receives 403 BLOCKED (zero oracle on D's block).
    const dBlocksA = await apiReq("/api/v1/blocks", tok("user-d"), {
      method: "POST",
      body: JSON.stringify({ schemaVersion: 1, blockedUserId: "user-a" }),
    });
    expect([200, 201]).toContain(dBlocksA.status);
    const mutualA = await apiReq("/api/v1/conversations", tok("user-a"), {
      method: "POST",
      body: JSON.stringify({ schemaVersion: 1, peerUserId: "user-d" }),
    });
    expect(mutualA.status).toBe(403);
    expect(mutualA.body.error?.code).toBe("BLOCKED");

    // Unblock restores conversation creation cleanly.
    const aUnblocksD = await apiReq("/api/v1/blocks/user-d", tok("user-a"), { method: "DELETE" });
    const dUnblocksA = await apiReq("/api/v1/blocks/user-a", tok("user-d"), { method: "DELETE" });
    expect([200, 204]).toContain(aUnblocksD.status);
    expect([200, 204]).toContain(dUnblocksA.status);
    const restoredCreate = await apiReq<{ created: boolean }>(
      "/api/v1/conversations",
      tok("user-d"),
      { method: "POST", body: JSON.stringify({ schemaVersion: 1, peerUserId: "user-a" }) },
    );
    expect(restoredCreate.status).toBe(201);

    // Pre-existing conversation stays readable to both, and blockedByViewer is true ONLY for blocker.
    const abRes = await apiReq<{ conversation: ConversationSummary; created: boolean }>(
      "/api/v1/conversations",
      tok("user-a"),
      { method: "POST", body: JSON.stringify({ schemaVersion: 1, peerUserId: "user-b" }) },
    );
    const abId = abRes.body.data!.conversation.id;

    // A blocks B after conversation exists.
    const httpBlock = await apiReq("/api/v1/blocks", tok("user-a"), {
      method: "POST",
      body: JSON.stringify({ schemaVersion: 1, blockedUserId: "user-b" }),
    });
    expect([200, 201]).toContain(httpBlock.status);

    // Both A and B still read the existing thread; blockedByViewer === true only for A.
    const aDetail = await apiReq<{ conversation: ConversationSummary }>(
      `/api/v1/conversations/${abId}`,
      tok("user-a"),
    );
    const bDetail = await apiReq<{ conversation: ConversationSummary }>(
      `/api/v1/conversations/${abId}`,
      tok("user-b"),
    );
    expect(aDetail.status).toBe(200);
    expect(aDetail.body.data!.conversation.blockedByViewer).toBe(true);
    expect(bDetail.status).toBe(200);
    expect(bDetail.body.data!.conversation.blockedByViewer).toBe(false);

    const aList = await apiReq<{ items: ConversationSummary[] }>(
      "/api/v1/conversations",
      tok("user-a"),
    );
    const bList = await apiReq<{ items: ConversationSummary[] }>(
      "/api/v1/conversations",
      tok("user-b"),
    );
    expect(aList.body.data!.items.find((c) => c.id === abId)!.blockedByViewer).toBe(true);
    expect(bList.body.data!.items.find((c) => c.id === abId)!.blockedByViewer).toBe(false);

    // Web client integrates cleanly against live HTTP server and maps ready/unavailable states.
    const clientA = new ConversationsClient({
      apiOrigin: baseUrl,
      expectedUserId: "user-a",
      getToken: () => tok("user-a"),
    });
    const clientDetailA = await clientA.get(abId);
    expect(clientDetailA.conversation.blockedByViewer).toBe(true);
    expect(toConversationOpenReadyState(clientDetailA.conversation, false)).toMatchObject({
      status: "ready",
      composeAllowed: false,
      noticeKey: "conversations.blockedByYouNotice",
    });

    const clientB = new ConversationsClient({
      apiOrigin: baseUrl,
      expectedUserId: "user-b",
      getToken: () => tok("user-b"),
    });
    await expect(
      clientB.createOrGet("user-a").catch((e) => mapConversationOpenError(e)),
    ).resolves.toMatchObject({
      status: "unavailable",
      code: "USER_UNAVAILABLE",
    });
  });

  it("enforces email verification, uncached session revocation, tombstone fallback, pagination, and 10/h rate limit", async () => {
    // Unverified requester denied.
    const unverified = await apiReq("/api/v1/conversations", tok("user-unverified"), {
      method: "POST",
      body: JSON.stringify({ schemaVersion: 1, peerUserId: "user-b" }),
    });
    expect(unverified.status).toBe(403);

    // Expired JWT denied cleanly.
    await seedUser("user-expired", "sid-exp", { expiresInSeconds: -10 });
    const expiredCreate = await apiReq("/api/v1/conversations", tok("user-expired"), {
      method: "POST",
      body: JSON.stringify({ schemaVersion: 1, peerUserId: "user-b" }),
    });
    expect(expiredCreate.status).toBe(401);
    expect(expiredCreate.body.error?.code).toBe("UNAUTHENTICATED");

    // Revoked session denied immediately on POST even if read cache previously cached the session.
    await seedUser("user-cached-rev", "sid-cached-rev");
    const warmRead = await apiReq("/api/v1/conversations", tok("user-cached-rev"));
    expect(warmRead.status).toBe(200);
    sessions.get("sid-cached-rev")!.revoked = true;
    const revokedCreate = await apiReq("/api/v1/conversations", tok("user-cached-rev"), {
      method: "POST",
      body: JSON.stringify({ schemaVersion: 1, peerUserId: "user-b" }),
    });
    expect(revokedCreate.status).toBe(401);
    expect(revokedCreate.body.error?.code).toBe("SESSION_REVOKED");

    // Uncached revoked session on read also returns 401 SESSION_REVOKED.
    await seedUser("user-rev", "sid-rev", { revoked: true });
    const revokedList = await apiReq("/api/v1/conversations", tok("user-rev"));
    expect(revokedList.status).toBe(401);
    expect(revokedList.body.error?.code).toBe("SESSION_REVOKED");

    // Deleted peer renders tombstone fields safely without breaking conversation read.
    await seedUser("user-deleted", "sid-del", { withProfile: true });
    const createdDel = await apiReq<{ conversation: ConversationSummary }>(
      "/api/v1/conversations",
      tok("user-a"),
      { method: "POST", body: JSON.stringify({ schemaVersion: 1, peerUserId: "user-deleted" }) },
    );
    expect(createdDel.status).toBe(201);
    profileMap.delete("user-deleted");
    const tombDetail = await apiReq<{ conversation: ConversationSummary }>(
      `/api/v1/conversations/${createdDel.body.data!.conversation.id}`,
      tok("user-a"),
    );
    expect(tombDetail.status).toBe(200);
    expect(tombDetail.body.data!.conversation.peer).toEqual({
      userId: "user-deleted",
      username: null,
      displayName: null,
      avatar: null,
    });

    // Pagination + rate limit (10/hour) across fresh user `user-rl`.
    await seedUser("user-rl", "sid-rl");
    const createdIds: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const peerId = `user-peer-${i}`;
      await seedUser(peerId, `sid-peer-${i}`);
      currentNow = new Date(Date.parse("2026-02-01T12:00:00.000Z") + i * 1000);
      const res = await apiReq<{ conversation: ConversationSummary; created: boolean }>(
        "/api/v1/conversations",
        tok("user-rl"),
        { method: "POST", body: JSON.stringify({ schemaVersion: 1, peerUserId: peerId }) },
      );
      expect(res.status).toBe(201);
      createdIds.push(res.body.data!.conversation.id);
    }

    // 11th create within hour hits 429 RATE_LIMITED with positive Retry-After.
    await seedUser("user-peer-11", "sid-peer-11");
    const rateLimited = await apiReq("/api/v1/conversations", tok("user-rl"), {
      method: "POST",
      body: JSON.stringify({ schemaVersion: 1, peerUserId: "user-peer-11" }),
    });
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.body.error?.code).toBe("RATE_LIMITED");
    expect(Number(rateLimited.headers.get("retry-after"))).toBeGreaterThan(0);

    // Cursor pagination walks all 10 threads cleanly in (lastActivityAt desc, id desc) order.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page++) {
      const query: string = cursor ? `?limit=4&before=${encodeURIComponent(cursor)}` : "?limit=4";
      const pageRes = await apiReq<{
        items: ConversationSummary[];
        nextCursor: string | null;
        hasMore: boolean;
      }>(`/api/v1/conversations${query}`, tok("user-rl"));
      expect(pageRes.status).toBe(200);
      const listData = pageRes.body.data!;
      seen.push(...listData.items.map((item) => item.id));
      cursor = listData.nextCursor;
      if (!listData.hasMore) break;
    }
    expect(seen).toEqual([...createdIds].reverse());

    // Invalid cursor, operator injection, and out-of-bounds limit rejected cleanly.
    const badLimit = await apiReq("/api/v1/conversations?limit=101", tok("user-rl"));
    expect(badLimit.status).toBe(400);
    expect(badLimit.body.error?.code).toBe("INVALID_REQUEST");

    const opInjectLimit = await apiReq("/api/v1/conversations?limit[$gt]=0", tok("user-rl"));
    expect(opInjectLimit.status).toBe(400);
    expect(opInjectLimit.body.error?.code).toBe("INVALID_REQUEST");

    const badCursor = await apiReq("/api/v1/conversations?before=@@bad", tok("user-rl"));
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.error?.code).toBe("INVALID_CURSOR");

    // Advance injected clock beyond 1h: limit recovers cleanly.
    currentNow = new Date(Date.parse("2026-02-01T13:05:00.000Z"));
    const recovered = await apiReq<{ conversation: ConversationSummary; created: boolean }>(
      "/api/v1/conversations",
      tok("user-rl"),
      { method: "POST", body: JSON.stringify({ schemaVersion: 1, peerUserId: "user-peer-11" }) },
    );
    expect(recovered.status).toBe(201);
  });
});
