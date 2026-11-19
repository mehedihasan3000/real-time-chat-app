import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { io as ioClient, type Socket } from "socket.io-client";
import {
  MESSAGE_ALLOWED_PROTOCOL_VERSION,
  MESSAGE_FORBIDDEN_FIELDS,
  MESSAGE_MAX_PLAINTEXT_CODE_POINTS,
  MESSAGE_SCHEMA_VERSION,
  PUBLIC_FIELDS,
  hasOnlyFields,
  type DevicePublicKeysResponse,
  type MessageSendResponse,
} from "@chat/contracts";
import { OlmAccountDevice, type OlmEncryptedEnvelope, type OlmPeerTarget } from "@chat/crypto";

import { createApp } from "../../apps/api/src/app.js";
import { createVerifier, mintTestToken } from "../../apps/api/src/auth/jwt.js";
import { clearSessionCache, type SessionRecord } from "../../apps/api/src/auth/session.js";
import { MemoryBlockStore } from "../../apps/api/src/blocks/store.js";
import { MemoryConversationStore } from "../../apps/api/src/conversations/index.js";
import { MemoryDeviceKeyStore } from "../../apps/api/src/keys/store.js";
import {
  MemoryMessageStore,
  MessageRateLimiter,
  type MessageRecord,
} from "../../apps/api/src/messages/index.js";
import { MemoryProfileStore, type ProfileRecord } from "../../apps/api/src/profiles/store.js";
import { createSocketServer } from "../../apps/api/src/socket/server.js";
import {
  ConversationsClient,
  MessageSendApiError,
  MessageSendClient,
  prepareEncryptedSend,
} from "../../apps/web/src/features/chat/index.js";
import { translate } from "../../apps/web/src/i18n/core.js";
import { errorCopyFor } from "../../apps/web/src/i18n/errors.js";

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
let deviceKeyStore = new MemoryDeviceKeyStore();
let messageStore = new MemoryMessageStore();
let messageRateLimiter = new MessageRateLimiter();
let committedMessages: MessageRecord[] = [];
const olmDevicesToDispose: OlmAccountDevice[] = [];

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
  profileMap.set(userId, makeProfile(userId, userId.replace(/-/g, "_"), `Synthetic ${userId}`));
}

async function apiReq<T = unknown>(
  path: string,
  token: string | null,
  init: RequestInit = {},
): Promise<{ status: number; headers: Headers; body: EnvelopeBody<T> }> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token !== null) {
    headers.authorization = `Bearer ${token}`;
  }
  if (init.body !== undefined && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const body = (await res.json()) as EnvelopeBody<T>;
  return { status: res.status, headers: res.headers, body };
}

async function createTrackedOlmDevice(deviceId: string): Promise<OlmAccountDevice> {
  const device = await OlmAccountDevice.create({ deviceId });
  olmDevicesToDispose.push(device);
  return device;
}

async function enrollOlmDevice(userId: string, deviceId: string): Promise<OlmAccountDevice> {
  const device = await createTrackedOlmDevice(deviceId);
  const res = await apiReq(
    `/api/v1/devices/${encodeURIComponent(device.deviceId)}/keys`,
    tok(userId),
    {
      method: "POST",
      body: JSON.stringify({ bundle: device.toPublicKeyBundle() }),
    },
  );
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  return device;
}

async function fetchPeerTarget(
  requesterUserId: string,
  peerUserId: string,
): Promise<OlmPeerTarget> {
  const res = await apiReq<DevicePublicKeysResponse>(
    `/api/v1/devices/${encodeURIComponent(peerUserId)}/public-keys`,
    tok(requesterUserId),
  );
  expect(res.status).toBe(200);
  const entry = res.body.data!.device;
  return {
    peerUserId: entry.userId,
    peerDeviceId: entry.deviceId,
    peerIdentityKey: entry.identityKey,
    peerSenderKey: entry.senderKey,
    peerOneTimeOrFallbackKey: entry.oneTimeKeys[0]?.key ?? entry.fallbackKey.key,
  };
}

async function openConversation(userId: string, peerUserId: string): Promise<string> {
  const client = new ConversationsClient({
    apiOrigin: baseUrl,
    expectedUserId: userId,
    getToken: () => tok(userId),
  });
  const result = await client.createOrGet(peerUserId);
  return result.conversation.id;
}

function makeSendClient(userId: string, deviceId: string): MessageSendClient {
  return new MessageSendClient({
    apiOrigin: baseUrl,
    expectedUserId: userId,
    expectedDeviceId: deviceId,
    getToken: () => tok(userId),
  });
}

function makeOpaqueEnvelope(
  plaintextPlaceholder = "not-checked-here",
  senderDeviceId = "dev-alice-01",
): string {
  const obj = {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
    senderDeviceId,
    recipientDeviceId: "dev-bob-01",
    senderIdentityKey: "a".repeat(43),
    senderCurve25519Key: "b".repeat(43),
    sessionId: "session-test-01",
    messageIndex: 0,
    messageType: 0 as const,
    ciphertext: Buffer.from(`fake-olm-ciphertext-${plaintextPlaceholder}`, "utf8").toString(
      "base64url",
    ),
  };
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function wireFromStored(stored: MessageRecord): OlmEncryptedEnvelope {
  const inner = JSON.parse(Buffer.from(stored.encryptedEnvelope, "base64url").toString("utf8")) as {
    recipientDeviceId: string;
    sessionId: string;
    messageType: 0 | 1;
  };
  return {
    schemaVersion: 1,
    protocolVersion: stored.protocolVersion,
    senderDeviceId: stored.senderDeviceId,
    recipientDeviceId: inner.recipientDeviceId,
    sessionId: inner.sessionId,
    messageType: inner.messageType,
    encryptedEnvelope: stored.encryptedEnvelope,
  };
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

  const proxyOf = <T extends object>(getter: () => T): T =>
    new Proxy({} as T, {
      get(_target, prop) {
        const current = getter();
        const value = Reflect.get(current, prop, current);
        return typeof value === "function" ? value.bind(current) : value;
      },
    });

  const blockStoreProxy = proxyOf(() => blockStore);
  const conversationStoreProxy = proxyOf(() => conversationStore);
  const deviceKeyStoreProxy = proxyOf(() => deviceKeyStore);
  const messageStoreProxy = proxyOf(() => messageStore);
  const messageRateLimiterProxy = proxyOf(() => messageRateLimiter);

  const app = createApp({
    verifier,
    sessionLookup: async (sid) => sessions.get(sid) ?? null,
    profileStore: profileStoreProxy,
    blockStore: blockStoreProxy,
    conversationStore: conversationStoreProxy,
    deviceKeyStore: deviceKeyStoreProxy,
    messageStore: messageStoreProxy,
    messageRateLimiter: messageRateLimiterProxy,
    onMessageCommitted: async (record) => {
      committedMessages.push(record);
    },
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
  deviceKeyStore = new MemoryDeviceKeyStore();
  messageStore = new MemoryMessageStore();
  messageRateLimiter = new MessageRateLimiter();
  committedMessages = [];

  await seedUser("user-a", "sid-a");
  await seedUser("user-b", "sid-b");
  await seedUser("user-c", "sid-c");
  await seedUser("user-unverified", "sid-unv", { emailVerified: false });
  await seedUser("user-suspended", "sid-sus", { eligible: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  while (olmDevicesToDispose.length > 0) {
    const device = olmDevicesToDispose.pop();
    try {
      device?.dispose();
    } catch {
      // ignore double dispose
    }
  }
});

describe("P2-04 integration — TC-CHAT-002 encrypted Olm send pipeline & redaction", () => {
  it("encrypts locally with vodozemac, commits durably via HTTP, decrypts on peer, and keeps logs/storage ciphertext-only", async () => {
    const alice = await enrollOlmDevice("user-a", "dev-alice-01");
    const bob = await enrollOlmDevice("user-b", "dev-bob-01");
    const convId = await openConversation("user-a", "user-b");
    const peerTarget = await fetchPeerTarget("user-a", "user-b");

    const secretMarker = "SYNTHETIC_SECRET_MARKER_P204_ALPHA";
    const plaintext = `Hello Bob! বাংলা বার্তা ✨ ${secretMarker}`;

    const logChunks: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      logChunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"),
      );
      return true;
    }) as typeof process.stdout.write);

    const client = makeSendClient("user-a", alice.deviceId);
    const outcome = await client.composeEncryptAndSend({
      conversationId: convId,
      senderDevice: alice,
      peerTarget,
      plaintext,
    });
    writeSpy.mockRestore();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.prepared.payload.protocolVersion).toBe(MESSAGE_ALLOWED_PROTOCOL_VERSION);
    expect(outcome.state.status).toBe("sent");
    if (outcome.state.status !== "sent") return;

    const sendRes: MessageSendResponse = outcome.state.response;
    expect(sendRes.idempotent).toBe(false);
    expect(hasOnlyFields(sendRes.message, PUBLIC_FIELDS.messageAck)).toBe(true);
    expect(sendRes.message.seq).toBe(1);
    expect(sendRes.message.conversationId).toBe(convId);
    expect(sendRes.message.senderUserId).toBe("user-a");
    expect(sendRes.message.senderDeviceId).toBe(alice.deviceId);
    expect(sendRes.message.clientMessageId).toBe(outcome.prepared.payload.clientMessageId);

    // Ack never echoes ciphertext or internal storage hashes.
    const serializedAck = JSON.stringify(sendRes);
    expect(serializedAck).not.toContain(secretMarker);
    expect(serializedAck).not.toContain("encryptedEnvelope");
    expect(serializedAck).not.toContain("payloadHash");
    expect(serializedAck).not.toContain("@");

    // Persistence hook ran once after commit; stored document holds ciphertext only.
    expect(committedMessages).toHaveLength(1);
    const storedList = await messageStore.listByConversation(convId);
    expect(storedList).toHaveLength(1);
    const stored = storedList[0]!;
    expect(stored.id).toBe(sendRes.message.messageId);
    expect(stored.seq).toBe(1);
    expect(stored.encryptedEnvelope).toBe(outcome.prepared.payload.encryptedEnvelope);
    expect(JSON.stringify(stored)).not.toContain(secretMarker);
    expect(JSON.stringify(stored)).not.toContain("বাংলা");

    // Peer device decrypts stored envelope back to exact Unicode + Bengali plaintext.
    const decrypted = await bob.decryptEnvelope(wireFromStored(stored), {
      expectedRecipientDeviceId: bob.deviceId,
      peerUserId: "user-a",
      expectedPeerIdentityKey: alice.toPublicKeyBundle().identityKey,
    });
    expect(decrypted.ok).toBe(true);
    if (!decrypted.ok) return;
    expect(decrypted.value.plaintext).toBe(plaintext);

    // Structured logs include correlation/status and never leak plaintext, ciphertext, or bearer token.
    const combinedLogs = logChunks.join("");
    expect(combinedLogs).toContain('"component":"http"');
    expect(combinedLogs).toContain('"status":201');
    expect(combinedLogs).not.toContain(secretMarker);
    expect(combinedLogs).not.toContain("বাংলা");
    expect(combinedLogs).not.toContain(outcome.prepared.payload.encryptedEnvelope);
    expect(combinedLogs).not.toContain(tok("user-a"));
  });
});

describe("P2-04 integration — TC-CHAT-003 idempotency, concurrency, seq gaps & ack-loss recovery", () => {
  it("deduplicates sequential and concurrent retries cleanly and rejects conflicting clientMessageId with 409", async () => {
    const alice = await enrollOlmDevice("user-a", "dev-alice-01");
    await enrollOlmDevice("user-b", "dev-bob-01");
    const convA = await openConversation("user-a", "user-b");
    const convC = await openConversation("user-a", "user-c");
    const peerTargetB = await fetchPeerTarget("user-a", "user-b");

    const preparedRes = await prepareEncryptedSend({
      conversationId: convA,
      senderDevice: alice,
      peerTarget: peerTargetB,
      plaintext: "Durable message one",
      clientMessageId: randomUUID(),
    });
    expect(preparedRes.ok).toBe(true);
    if (!preparedRes.ok) return;
    const prepared = preparedRes.prepared;

    const client = makeSendClient("user-a", alice.deviceId);

    // Concurrent race with identical clientMessageId + envelope converges to 1 durable row.
    const raceResults = await Promise.all([
      client.sendPrepared(prepared),
      client.sendPrepared(prepared),
      client.sendPrepared(prepared),
    ]);
    const uniqueIds = new Set(raceResults.map((r) => r.message.messageId));
    const uniqueSeqs = new Set(raceResults.map((r) => r.message.seq));
    expect(uniqueIds.size).toBe(1);
    expect(uniqueSeqs).toEqual(new Set([1]));
    expect(raceResults.filter((r) => !r.idempotent)).toHaveLength(1);
    expect(raceResults.filter((r) => r.idempotent)).toHaveLength(2);
    expect(committedMessages).toHaveLength(1);
    expect(await messageStore.listByConversation(convA)).toHaveLength(1);

    // Explicit sequential retry yields 200 idempotent: true with matching seq & messageId.
    const rawRetry = await apiReq<MessageSendResponse>(
      `/api/v1/conversations/${convA}/messages`,
      tok("user-a"),
      { method: "POST", body: JSON.stringify(prepared.payload) },
    );
    expect(rawRetry.status).toBe(200);
    expect(rawRetry.body.data!.idempotent).toBe(true);
    expect(rawRetry.body.data!.message.messageId).toBe(raceResults[0]!.message.messageId);
    expect(rawRetry.body.data!.message.seq).toBe(1);
    expect(committedMessages).toHaveLength(1);

    // Same clientMessageId reused with different envelope -> 409 IDEMPOTENCY_CONFLICT.
    const diffEnvelopeRes = await prepareEncryptedSend({
      conversationId: convA,
      senderDevice: alice,
      peerTarget: peerTargetB,
      plaintext: "Tampered different content under same clientMessageId",
      clientMessageId: prepared.payload.clientMessageId,
    });
    expect(diffEnvelopeRes.ok).toBe(true);
    if (!diffEnvelopeRes.ok) return;

    const conflictEnvelope = await apiReq(
      `/api/v1/conversations/${convA}/messages`,
      tok("user-a"),
      { method: "POST", body: JSON.stringify(diffEnvelopeRes.prepared.payload) },
    );
    expect(conflictEnvelope.status).toBe(409);
    expect(conflictEnvelope.body.error).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      retryable: false,
    });

    // Same clientMessageId reused on a different conversation -> 409 IDEMPOTENCY_CONFLICT.
    const conflictConv = await apiReq(`/api/v1/conversations/${convC}/messages`, tok("user-a"), {
      method: "POST",
      body: JSON.stringify(prepared.payload),
    });
    expect(conflictConv.status).toBe(409);
    expect(conflictConv.body.error).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      retryable: false,
    });
  });

  it("permits permanent seq gaps on write failures after seq reservation and recovers cleanly from ack loss without double storage", async () => {
    const alice = await enrollOlmDevice("user-a", "dev-alice-01");
    await enrollOlmDevice("user-b", "dev-bob-01");
    const convId = await openConversation("user-a", "user-b");
    const peerTargetB = await fetchPeerTarget("user-a", "user-b");

    // 1. Fail after seq reserve, before insert -> 503 unknown, seq=1 stays a permanent gap.
    let failBeforeInsert = true;
    messageStore = new MemoryMessageStore({
      afterSeqReserveBeforeInsert: () => {
        if (failBeforeInsert) {
          failBeforeInsert = false;
          throw new Error("Simulated write failure after seq reservation");
        }
      },
    });

    const msg1Prep = await prepareEncryptedSend({
      conversationId: convId,
      senderDevice: alice,
      peerTarget: peerTargetB,
      plaintext: "Recover after seq gap",
    });
    expect(msg1Prep.ok).toBe(true);
    if (!msg1Prep.ok) return;

    const client = makeSendClient("user-a", alice.deviceId);
    let capturedErr: unknown = null;
    try {
      await client.sendPrepared(msg1Prep.prepared);
    } catch (err) {
      capturedErr = err;
    }
    expect(capturedErr).toBeInstanceOf(MessageSendApiError);
    expect((capturedErr as MessageSendApiError).status).toBe(503);
    expect((capturedErr as MessageSendApiError).code).toBe("TEMPORARILY_UNAVAILABLE");
    expect((capturedErr as MessageSendApiError).disposition).toBe("unknown");
    expect(await messageStore.listByConversation(convId)).toHaveLength(0);
    expect((await conversationStore.getById(convId))!.lastSeq).toBe(1);

    // Retry re-submits exact same prepared envelope -> commits at seq 2 (gap at seq 1 preserved).
    const retryAfterGap = await client.sendPrepared(msg1Prep.prepared);
    expect(retryAfterGap.idempotent).toBe(false);
    expect(retryAfterGap.message.seq).toBe(2);
    expect((await conversationStore.getById(convId))!.lastSeq).toBe(2);

    // 2. Simulate post-insert/pre-ack failure (client gets 503 unknown while row committed at seq 3).
    let failBeforeAck = true;
    messageStore = new MemoryMessageStore({
      afterInsertBeforeAck: () => {
        if (failBeforeAck) {
          failBeforeAck = false;
          throw new Error("Simulated ack loss after durable commit");
        }
      },
    });

    const msg2Prep = await prepareEncryptedSend({
      conversationId: convId,
      senderDevice: alice,
      peerTarget: peerTargetB,
      plaintext: "Recover from lost 201 ack",
    });
    expect(msg2Prep.ok).toBe(true);
    if (!msg2Prep.ok) return;

    let ackLossErr: unknown = null;
    try {
      await client.sendPrepared(msg2Prep.prepared);
    } catch (err) {
      ackLossErr = err;
    }
    expect(ackLossErr).toBeInstanceOf(MessageSendApiError);
    expect((ackLossErr as MessageSendApiError).status).toBe(503);
    expect((ackLossErr as MessageSendApiError).disposition).toBe("unknown");

    // Server actually committed at seq=3 before failing the ack.
    const storedAfterLoss = await messageStore.listByConversation(convId);
    expect(storedAfterLoss).toHaveLength(1);
    expect(storedAfterLoss[0]!.seq).toBe(3);

    // Client retries same PreparedEncryptedSend -> recovers 200 idempotent: true at seq=3 with 1 stored message.
    const recovered = await client.sendPrepared(msg2Prep.prepared);
    expect(recovered.idempotent).toBe(true);
    expect(recovered.message.messageId).toBe(storedAfterLoss[0]!.id);
    expect(recovered.message.seq).toBe(3);
    expect(await messageStore.listByConversation(convId)).toHaveLength(1);
  });
});

describe("P2-04 integration — auth, session revocation, membership, device checks & contract guards", () => {
  it("enforces fail-closed auth, fresh session revocation check, uniform 404 isolation & device checks", async () => {
    const alice = await enrollOlmDevice("user-a", "dev-alice-01");
    const bob = await enrollOlmDevice("user-b", "dev-bob-01");
    const convId = await openConversation("user-a", "user-b");
    const peerTargetB = await fetchPeerTarget("user-a", "user-b");

    const prepRes = await prepareEncryptedSend({
      conversationId: convId,
      senderDevice: alice,
      peerTarget: peerTargetB,
      plaintext: "Guarded send test",
    });
    expect(prepRes.ok).toBe(true);
    if (!prepRes.ok) return;
    const validPayload = prepRes.prepared.payload;

    // Missing Bearer token -> 401 UNAUTHENTICATED
    const noAuth = await apiReq(`/api/v1/conversations/${convId}/messages`, null, {
      method: "POST",
      body: JSON.stringify(validPayload),
    });
    expect(noAuth.status).toBe(401);
    expect(noAuth.body.error?.code).toBe("UNAUTHENTICATED");

    // Expired JWT -> 401 UNAUTHENTICATED
    await seedUser("user-expired", "sid-exp", { expiresInSeconds: -30 });
    const expired = await apiReq(`/api/v1/conversations/${convId}/messages`, tok("user-expired"), {
      method: "POST",
      body: JSON.stringify(validPayload),
    });
    expect(expired.status).toBe(401);
    expect(expired.body.error?.code).toBe("UNAUTHENTICATED");

    // Unverified account -> 403 FORBIDDEN
    const unverified = await apiReq(
      `/api/v1/conversations/${convId}/messages`,
      tok("user-unverified"),
      { method: "POST", body: JSON.stringify(validPayload) },
    );
    expect(unverified.status).toBe(403);
    expect(unverified.body.error?.code).toBe("FORBIDDEN");

    // Non-member user-c receives uniform 404 NOT_FOUND indistinguishable from missing convId
    const nonMemberRes = await apiReq(`/api/v1/conversations/${convId}/messages`, tok("user-c"), {
      method: "POST",
      body: JSON.stringify(validPayload),
    });
    const missingConvRes = await apiReq(
      "/api/v1/conversations/conv_does_not_exist_123/messages",
      tok("user-c"),
      { method: "POST", body: JSON.stringify(validPayload) },
    );
    expect(nonMemberRes.status).toBe(404);
    expect(missingConvRes.status).toBe(404);
    expect(nonMemberRes.body.error).toEqual(missingConvRes.body.error);

    // Using another user's or unknown deviceId (matching inner envelope) -> 403 FORBIDDEN
    const wrongDevice = await apiReq(`/api/v1/conversations/${convId}/messages`, tok("user-a"), {
      method: "POST",
      body: JSON.stringify({
        ...validPayload,
        senderDeviceId: bob.deviceId,
        encryptedEnvelope: makeOpaqueEnvelope("bob-device", bob.deviceId),
      }),
    });
    expect(wrongDevice.status).toBe(403);
    expect(wrongDevice.body.error?.code).toBe("FORBIDDEN");

    const unknownDevice = await apiReq(`/api/v1/conversations/${convId}/messages`, tok("user-a"), {
      method: "POST",
      body: JSON.stringify({
        ...validPayload,
        senderDeviceId: "dev-unknown-01",
        encryptedEnvelope: makeOpaqueEnvelope("unknown-device", "dev-unknown-01"),
      }),
    });
    expect(unknownDevice.status).toBe(403);
    expect(unknownDevice.body.error?.code).toBe("FORBIDDEN");

    // Warm session cache on GET /conversations, then revoke sid-a -> sensitive POST rejects 401 SESSION_REVOKED
    const warmList = await apiReq("/api/v1/conversations", tok("user-a"));
    expect(warmList.status).toBe(200);
    sessions.get("sid-a")!.revoked = true;

    const client = makeSendClient("user-a", alice.deviceId);
    const revokedOutcome = await client.composeEncryptAndSend({
      conversationId: convId,
      senderDevice: alice,
      peerTarget: peerTargetB,
      plaintext: "Should be stopped by fresh session check",
    });
    expect(revokedOutcome.ok).toBe(false);
    if (!revokedOutcome.ok) {
      expect(revokedOutcome.state.status).toBe("unauthenticated");
      if (revokedOutcome.state.status === "unauthenticated") {
        expect(revokedOutcome.state.code).toBe("SESSION_REVOKED");
      }
    }

    // Restore session, revoke sender device -> 403 DEVICE_REVOKED
    sessions.get("sid-a")!.revoked = false;
    const revokeRes = await apiReq(
      `/api/v1/devices/${encodeURIComponent(alice.deviceId)}/revoke`,
      tok("user-a"),
      { method: "POST", body: JSON.stringify({ reason: "loss" }) },
    );
    expect(revokeRes.status).toBe(200);

    const revokedDevAttempt = await apiReq(
      `/api/v1/conversations/${convId}/messages`,
      tok("user-a"),
      { method: "POST", body: JSON.stringify(validPayload) },
    );
    expect(revokedDevAttempt.status).toBe(403);
    expect(revokedDevAttempt.body.error?.code).toBe("DEVICE_REVOKED");
    expect(await messageStore.listByConversation(convId)).toHaveLength(0);
  });

  it("rejects plaintext/extra fields, downgraded protocolVersion, oversized payloads & operator injection without persisting", async () => {
    const alice = await enrollOlmDevice("user-a", "dev-alice-01");
    await enrollOlmDevice("user-b", "dev-bob-01");
    const convId = await openConversation("user-a", "user-b");
    const peerTargetB = await fetchPeerTarget("user-a", "user-b");

    const basePrep = await prepareEncryptedSend({
      conversationId: convId,
      senderDevice: alice,
      peerTarget: peerTargetB,
      plaintext: "Valid base",
    });
    expect(basePrep.ok).toBe(true);
    if (!basePrep.ok) return;
    const valid = basePrep.prepared.payload;

    // Forbidden extra / plaintext / server-owned fields -> 400 INVALID_REQUEST
    for (const forbidden of MESSAGE_FORBIDDEN_FIELDS) {
      const bad = await apiReq(`/api/v1/conversations/${convId}/messages`, tok("user-a"), {
        method: "POST",
        body: JSON.stringify({ ...valid, [forbidden]: "injected" }),
      });
      expect(bad.status).toBe(400);
      expect(bad.body.error?.code).toBe("INVALID_REQUEST");
    }

    // Operator injection -> 400 INVALID_REQUEST
    const opInj = await apiReq(`/api/v1/conversations/${convId}/messages`, tok("user-a"), {
      method: "POST",
      body: JSON.stringify({ ...valid, clientMessageId: { $ne: null } }),
    });
    expect(opInj.status).toBe(400);
    expect(opInj.body.error?.code).toBe("INVALID_REQUEST");

    // Protocol downgrade ("olm-v0" / "plaintext" / "olm-v1") -> 422 UNSUPPORTED_SCHEMA_VERSION
    for (const proto of ["olm-v0", "plaintext", "olm-v1"]) {
      const downgraded = await apiReq(`/api/v1/conversations/${convId}/messages`, tok("user-a"), {
        method: "POST",
        body: JSON.stringify({ ...valid, protocolVersion: proto }),
      });
      expect(downgraded.status).toBe(422);
      expect(downgraded.body.error?.code).toBe("UNSUPPORTED_SCHEMA_VERSION");
    }

    // Unsupported schemaVersion -> 422 UNSUPPORTED_SCHEMA_VERSION
    const wrongSchema = await apiReq(`/api/v1/conversations/${convId}/messages`, tok("user-a"), {
      method: "POST",
      body: JSON.stringify({ ...valid, schemaVersion: MESSAGE_SCHEMA_VERSION + 1 }),
    });
    expect(wrongSchema.status).toBe(422);
    expect(wrongSchema.body.error?.code).toBe("UNSUPPORTED_SCHEMA_VERSION");

    // Oversized decoded encryptedEnvelope (>16 KiB) -> 413 PAYLOAD_TOO_LARGE
    const oversizedEnv = await apiReq(`/api/v1/conversations/${convId}/messages`, tok("user-a"), {
      method: "POST",
      body: JSON.stringify({
        ...valid,
        encryptedEnvelope: Buffer.alloc(16 * 1024 + 32, 0x61).toString("base64url"),
      }),
    });
    expect(oversizedEnv.status).toBe(413);
    expect(oversizedEnv.body.error?.code).toBe("PAYLOAD_TOO_LARGE");

    // Client-side compose / encrypt failures NEVER invoke fetch (no plaintext fallback)
    const spyFetch = vi.fn<typeof fetch>();
    const spyClient = new MessageSendClient({
      apiOrigin: baseUrl,
      expectedUserId: "user-a",
      expectedDeviceId: alice.deviceId,
      getToken: () => tok("user-a"),
      fetchImpl: spyFetch,
    });
    const overMaxPlaintext = "x".repeat(MESSAGE_MAX_PLAINTEXT_CODE_POINTS + 1);
    const tooLongOutcome = await spyClient.composeEncryptAndSend({
      conversationId: convId,
      senderDevice: alice,
      peerTarget: peerTargetB,
      plaintext: overMaxPlaintext,
    });
    expect(tooLongOutcome.ok).toBe(false);
    expect(spyFetch).not.toHaveBeenCalled();

    // Disposed crypto device fails closed without fetch call
    alice.dispose();
    const disposedOutcome = await spyClient.composeEncryptAndSend({
      conversationId: convId,
      senderDevice: alice,
      peerTarget: peerTargetB,
      plaintext: "Should not go out unencrypted",
    });
    expect(disposedOutcome.ok).toBe(false);
    expect(spyFetch).not.toHaveBeenCalled();
    expect(await messageStore.listByConversation(convId)).toHaveLength(0);
  });
});

describe("P2-04 integration — block enforcement, rate limiting & Socket.IO write prohibition", () => {
  it("enforces bilateral blocking without disclosing block status to blocked peer and resumes after unblock", async () => {
    const alice = await enrollOlmDevice("user-a", "dev-alice-01");
    const bob = await enrollOlmDevice("user-b", "dev-bob-01");
    const convId = await openConversation("user-a", "user-b");
    const peerTargetB = await fetchPeerTarget("user-a", "user-b");
    const peerTargetA = await fetchPeerTarget("user-b", "user-a");

    // Alice prepares message for Bob; Bob prepares message for Alice.
    const aPrep = await prepareEncryptedSend({
      conversationId: convId,
      senderDevice: alice,
      peerTarget: peerTargetB,
      plaintext: "Hi Bob",
    });
    const bPrep = await prepareEncryptedSend({
      conversationId: convId,
      senderDevice: bob,
      peerTarget: peerTargetA,
      plaintext: "Hi Alice",
    });
    expect(aPrep.ok && bPrep.ok).toBe(true);
    if (!aPrep.ok || !bPrep.ok) return;

    // Alice blocks Bob
    const blockRes = await apiReq("/api/v1/blocks", tok("user-a"), {
      method: "POST",
      body: JSON.stringify({ schemaVersion: 1, blockedUserId: "user-b" }),
    });
    expect([200, 201]).toContain(blockRes.status);

    // Blocked peer (Bob) gets generic 403 UNAVAILABLE with non-block-disclosing copy
    const bobBlockedSend = await apiReq(`/api/v1/conversations/${convId}/messages`, tok("user-b"), {
      method: "POST",
      body: JSON.stringify(bPrep.prepared.payload),
    });
    expect(bobBlockedSend.status).toBe(403);
    expect(bobBlockedSend.body.error?.code).toBe("UNAVAILABLE");
    expect(bobBlockedSend.body.error?.message.toLowerCase()).not.toContain("block");
    const enCopy = errorCopyFor("UNAVAILABLE");
    expect(translate("en", enCopy.titleKey).toLowerCase()).not.toContain("block");
    expect(translate("en", enCopy.descriptionKey).toLowerCase()).not.toContain("block");

    // Blocker (Alice) gets 403 BLOCKED
    const aliceBlockedSend = await apiReq(
      `/api/v1/conversations/${convId}/messages`,
      tok("user-a"),
      { method: "POST", body: JSON.stringify(aPrep.prepared.payload) },
    );
    expect(aliceBlockedSend.status).toBe(403);
    expect(aliceBlockedSend.body.error?.code).toBe("BLOCKED");
    expect(await messageStore.listByConversation(convId)).toHaveLength(0);
    expect((await conversationStore.getById(convId))!.lastSeq).toBe(0);

    // Unblock restores normal send
    const unblockRes = await apiReq("/api/v1/blocks/user-b", tok("user-a"), { method: "DELETE" });
    expect([200, 204]).toContain(unblockRes.status);

    const afterUnblock = await apiReq<MessageSendResponse>(
      `/api/v1/conversations/${convId}/messages`,
      tok("user-a"),
      { method: "POST", body: JSON.stringify(aPrep.prepared.payload) },
    );
    expect(afterUnblock.status).toBe(201);
    expect(afterUnblock.body.data!.message.seq).toBe(1);
  });

  it("enforces default 30/minute per-user send limit with 429 RATE_LIMITED + Retry-After and window reset", async () => {
    await enrollOlmDevice("user-a", "dev-alice-01");
    await enrollOlmDevice("user-b", "dev-bob-01");
    const convId = await openConversation("user-a", "user-b");
    const client = makeSendClient("user-a", "dev-alice-01");

    for (let i = 1; i <= 30; i += 1) {
      const res = await client.sendPrepared({
        conversationId: convId,
        payload: {
          schemaVersion: MESSAGE_SCHEMA_VERSION,
          clientMessageId: randomUUID(),
          senderDeviceId: "dev-alice-01",
          protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
          encryptedEnvelope: makeOpaqueEnvelope(`burst-${i}`),
        },
      });
      expect(res.idempotent).toBe(false);
      expect(res.message.seq).toBe(i);
    }

    const thirtyFirst = await apiReq(`/api/v1/conversations/${convId}/messages`, tok("user-a"), {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: MESSAGE_SCHEMA_VERSION,
        clientMessageId: randomUUID(),
        senderDeviceId: "dev-alice-01",
        protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
        encryptedEnvelope: makeOpaqueEnvelope("burst-31"),
      }),
    });
    expect(thirtyFirst.status).toBe(429);
    expect(thirtyFirst.body.error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(Number(thirtyFirst.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);

    // Advance clock past 60s sliding minute window -> next send succeeds cleanly
    currentNow = new Date(currentNow.getTime() + 61_000);
    const afterWindow = await client.sendPrepared({
      conversationId: convId,
      payload: {
        schemaVersion: MESSAGE_SCHEMA_VERSION,
        clientMessageId: randomUUID(),
        senderDeviceId: "dev-alice-01",
        protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
        encryptedEnvelope: makeOpaqueEnvelope("after-window"),
      },
    });
    expect(afterWindow.message.seq).toBe(31);
  });

  it("rejects Socket.IO message:send writes with FORBIDDEN ack and never persists or broadcasts", async () => {
    const alice = await enrollOlmDevice("user-a", "dev-alice-01");
    await enrollOlmDevice("user-b", "dev-bob-01");
    const convId = await openConversation("user-a", "user-b");

    const sockA = ioClient(`${baseUrl}/v1`, {
      auth: { token: tok("user-a") },
      extraHeaders: { origin: ISS },
      reconnection: false,
      transports: ["websocket"],
    });
    const sockB = ioClient(`${baseUrl}/v1`, {
      auth: { token: tok("user-b") },
      extraHeaders: { origin: ISS },
      reconnection: false,
      transports: ["websocket"],
    });

    const receivedOnB: unknown[] = [];
    sockB.on("message:new", (payload) => receivedOnB.push(payload));

    try {
      await Promise.all([waitConnect(sockA), waitConnect(sockB)]);
      const joinB = await emitAck(sockB, "join", {
        schemaVersion: 1,
        conversationId: convId,
        data: { conversationId: convId },
      });
      expect(joinB).toMatchObject({ ok: true });

      const ack = (await emitAck(sockA, "message:send", {
        schemaVersion: MESSAGE_SCHEMA_VERSION,
        conversationId: convId,
        clientMessageId: randomUUID(),
        senderDeviceId: alice.deviceId,
        protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
        encryptedEnvelope: makeOpaqueEnvelope("socket-denied"),
      })) as EnvelopeBody;

      expect(ack.ok).toBe(false);
      expect(ack.error).toMatchObject({
        code: "FORBIDDEN",
        retryable: false,
      });
      expect(await messageStore.listByConversation(convId)).toHaveLength(0);
      expect(receivedOnB).toHaveLength(0);
    } finally {
      sockA.disconnect();
      sockB.disconnect();
    }
  });
});
