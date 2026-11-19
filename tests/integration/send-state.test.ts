import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type DevicePublicKeysResponse } from "@chat/contracts";
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
import {
  ConversationsClient,
  MessageSendClient,
  prepareEncryptedSend,
} from "../../apps/web/src/features/chat/index.js";
import {
  InMemoryOutboxStorageAdapter,
  SendOutboxCoordinator,
} from "../../apps/web/src/lib/outbox/index.js";

const ISS = "https://app.example.test";
const AUD = "https://api.example.test";

let server: Server;
let baseUrl = "";
let keyPair!: Awaited<ReturnType<typeof mintTestToken>>["keyPair"];
let tokens = new Map<string, string>();
let sessions = new Map<string, SessionRecord>();
let profileMap = new Map<string, ProfileRecord>();

let blockStore = new MemoryBlockStore();
let conversationStore = new MemoryConversationStore();
let deviceKeyStore = new MemoryDeviceKeyStore();
let messageStore = new MemoryMessageStore();
let messageRateLimiter = new MessageRateLimiter();
const devicesToDispose: OlmAccountDevice[] = [];

function tok(userId: string): string {
  const token = tokens.get(userId);
  if (!token) throw new Error(`Missing token for ${userId}`);
  return token;
}

async function seedUser(userId: string, sid: string) {
  const minted = await mintTestToken({
    sub: userId,
    sid,
    emailVerified: true,
    iss: ISS,
    aud: AUD,
    keyPair,
  });
  tokens.set(userId, minted.token);
  sessions.set(sid, { sid, userId, revoked: false, authenticatedAt: new Date() });
  profileMap.set(userId, {
    userId,
    username: userId.replace(/-/g, "_"),
    displayName: `Synthetic ${userId}`,
    avatar: null,
    locale: "en",
    timeZone: "UTC",
  });
}

async function enrollOlmDevice(userId: string, deviceId: string): Promise<OlmAccountDevice> {
  const device = await OlmAccountDevice.create({ deviceId });
  devicesToDispose.push(device);
  const res = await fetch(`${baseUrl}/api/v1/devices/${encodeURIComponent(device.deviceId)}/keys`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tok(userId)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ bundle: device.toPublicKeyBundle() }),
  });
  expect(res.status).toBe(200);
  return device;
}

async function fetchPeerTarget(requester: string, peer: string): Promise<OlmPeerTarget> {
  const res = await fetch(`${baseUrl}/api/v1/devices/${encodeURIComponent(peer)}/public-keys`, {
    headers: { authorization: `Bearer ${tok(requester)}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: DevicePublicKeysResponse };
  const d = body.data.device;
  return {
    peerUserId: d.userId,
    peerDeviceId: d.deviceId,
    peerIdentityKey: d.identityKey,
    peerSenderKey: d.senderKey,
    peerOneTimeOrFallbackKey: d.oneTimeKeys[0]?.key ?? d.fallbackKey.key,
  };
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

  const app = createApp({
    verifier,
    sessionLookup: async (sid) => sessions.get(sid) ?? null,
    profileStore: profileStoreProxy,
    blockStore: proxyOf(() => blockStore),
    conversationStore: proxyOf(() => conversationStore),
    deviceKeyStore: proxyOf(() => deviceKeyStore),
    messageStore: proxyOf(() => messageStore),
    messageRateLimiter: proxyOf(() => messageRateLimiter),
    userEligibilityLookup: async () => true,
  });

  server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Expected TCP address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  clearSessionCache();
  tokens = new Map();
  sessions = new Map();
  profileMap = new Map();
  blockStore = new MemoryBlockStore();
  conversationStore = new MemoryConversationStore();
  deviceKeyStore = new MemoryDeviceKeyStore();
  messageStore = new MemoryMessageStore();
  messageRateLimiter = new MessageRateLimiter();

  await seedUser("user-a", "sid-a");
  await seedUser("user-b", "sid-b");
});

afterEach(() => {
  while (devicesToDispose.length > 0) {
    try {
      devicesToDispose.pop()?.dispose();
    } catch {
      // ignore
    }
  }
});

describe("P2-05 integration — TC-CHAT-005 disconnect, dropped-ack, reload & revocation reconciliation", () => {
  it("handles offline queueing, dropped 201 ack -> reload -> idempotent recovery without duplicate DB rows", async () => {
    const alice = await enrollOlmDevice("user-a", "dev-alice-01");
    const bob = await enrollOlmDevice("user-b", "dev-bob-01");
    const convClient = new ConversationsClient({
      apiOrigin: baseUrl,
      expectedUserId: "user-a",
      getToken: () => tok("user-a"),
    });
    const convId = (await convClient.createOrGet("user-b")).conversation.id;
    const peerTargetB = await fetchPeerTarget("user-a", "user-b");

    const storage = new InMemoryOutboxStorageAdapter();
    let now = 1_763_500_000_000;
    const sendClient = new MessageSendClient({
      apiOrigin: baseUrl,
      expectedUserId: "user-a",
      expectedDeviceId: alice.deviceId,
      getToken: () => tok("user-a"),
    });

    // 1. Offline send stays queued until connectivity returns
    const coordinator = new SendOutboxCoordinator({
      accountId: "user-a",
      activeConversationId: convId,
      sender: sendClient,
      storage,
      online: false,
      nowMs: () => now,
      random: () => 0.5,
      scheduleTimer: () => 0,
      cancelTimer: () => {},
    });

    const offlinePrep = await prepareEncryptedSend({
      conversationId: convId,
      senderDevice: alice,
      peerTarget: peerTargetB,
      plaintext: "Sent after reconnect",
    });
    expect(offlinePrep.ok).toBe(true);
    if (!offlinePrep.ok) return;

    const queued = await coordinator.submitPrepared(offlinePrep.prepared);
    expect(queued.status).toBe("queued");
    expect(await messageStore.listByConversation(convId)).toHaveLength(0);

    await coordinator.setOnline(true);
    const afterReconnect = coordinator.getSnapshot().entriesForActiveConversation[0]!;
    expect(afterReconnect.status).toBe("sent");
    expect(afterReconnect.committedSeq).toBe(1);

    // 2. Dropped 201 ack (afterInsertBeforeAck throws once -> HTTP 503 unknown)
    let dropAck = true;
    messageStore = new MemoryMessageStore({
      afterInsertBeforeAck: () => {
        if (dropAck) {
          dropAck = false;
          throw new Error("Simulated dropped 201 ack");
        }
      },
    });
    // Reset message list baseline for clear assertion on this dropped-ack item
    const droppedPrep = await prepareEncryptedSend({
      conversationId: convId,
      senderDevice: alice,
      peerTarget: peerTargetB,
      plaintext: "Must not duplicate across ack drop + reload",
    });
    expect(droppedPrep.ok).toBe(true);
    if (!droppedPrep.ok) return;

    const droppedResult = await coordinator.submitPrepared(droppedPrep.prepared);
    expect(droppedResult.status).toBe("unknown");
    expect(droppedResult.committedMessageId).toBeNull();
    expect(await messageStore.listByConversation(convId)).toHaveLength(1);

    // Simulated reload while offline preserves exact clientMessageId & unknown state
    await coordinator.setOnline(false);
    await coordinator.reconcileAfterReload();
    const reloadedItem = coordinator
      .getSnapshot()
      .entriesForActiveConversation.find(
        (e) => e.clientMessageId === droppedPrep.prepared.payload.clientMessageId,
      )!;
    expect(reloadedItem.status).toBe("unknown");

    // Reconnect resolves to same seq/messageId via server idempotency (1 row stored)
    now += 5000;
    await coordinator.setOnline(true);
    const confirmedItem = coordinator
      .getSnapshot()
      .entriesForActiveConversation.find(
        (e) => e.clientMessageId === droppedPrep.prepared.payload.clientMessageId,
      )!;
    expect(confirmedItem.status).toBe("sent");
    expect(confirmedItem.committedSeq).toBe(2);
    const storedRows = await messageStore.listByConversation(convId);
    expect(storedRows).toHaveLength(1);

    const decrypted = await bob.decryptEnvelope(wireFromStored(storedRows[0]!), {
      expectedRecipientDeviceId: bob.deviceId,
      peerUserId: "user-a",
      expectedPeerIdentityKey: alice.toPublicKeyBundle().identityKey,
    });
    expect(decrypted.ok).toBe(true);
    if (decrypted.ok) {
      expect(decrypted.value.plaintext).toBe("Must not duplicate across ack drop + reload");
    }
  });

  it("maps 409 conflict, 401 session revocation, and 403 device revocation to truthful actionable states", async () => {
    const alice = await enrollOlmDevice("user-a", "dev-alice-01");
    await enrollOlmDevice("user-b", "dev-bob-01");
    const convClient = new ConversationsClient({
      apiOrigin: baseUrl,
      expectedUserId: "user-a",
      getToken: () => tok("user-a"),
    });
    const convId = (await convClient.createOrGet("user-b")).conversation.id;
    const peerTargetB = await fetchPeerTarget("user-a", "user-b");

    const storage = new InMemoryOutboxStorageAdapter();
    const coordinator = new SendOutboxCoordinator({
      accountId: "user-a",
      activeConversationId: convId,
      sender: new MessageSendClient({
        apiOrigin: baseUrl,
        expectedUserId: "user-a",
        expectedDeviceId: alice.deviceId,
        getToken: () => tok("user-a"),
      }),
      storage,
      online: true,
      nowMs: () => 1_763_500_010_000,
      scheduleTimer: () => 0,
      cancelTimer: () => {},
    });

    const stableId = randomUUID();
    const first = await prepareEncryptedSend({
      conversationId: convId,
      senderDevice: alice,
      peerTarget: peerTargetB,
      plaintext: "Original send",
      clientMessageId: stableId,
    });
    const conflicting = await prepareEncryptedSend({
      conversationId: convId,
      senderDevice: alice,
      peerTarget: peerTargetB,
      plaintext: "Different content with same clientMessageId",
      clientMessageId: stableId,
    });
    expect(first.ok && conflicting.ok).toBe(true);
    if (!first.ok || !conflicting.ok) return;

    const okRes = await coordinator.submitPrepared(first.prepared);
    expect(okRes.status).toBe("sent");

    // 409 IDEMPOTENCY_CONFLICT -> failed (conflict, no manual retry)
    const conflictOut = await coordinator.submitPrepared(conflicting.prepared);
    expect(conflictOut.status).toBe("failed");
    expect(conflictOut.failureReason).toBe("conflict");
    expect(conflictOut.errorCode).toBe("IDEMPOTENCY_CONFLICT");

    // 401 SESSION_REVOKED -> reauth_required
    sessions.get("sid-a")!.revoked = true;
    const revSessPrep = await prepareEncryptedSend({
      conversationId: convId,
      senderDevice: alice,
      peerTarget: peerTargetB,
      plaintext: "While session revoked",
    });
    expect(revSessPrep.ok).toBe(true);
    if (!revSessPrep.ok) return;
    const revSessOut = await coordinator.submitPrepared(revSessPrep.prepared);
    expect(revSessOut.status).toBe("failed");
    expect(revSessOut.failureReason).toBe("reauth_required");
    expect(revSessOut.errorCode).toBe("SESSION_REVOKED");

    // Restore session, revoke device -> 403 DEVICE_REVOKED -> device_revoked
    sessions.get("sid-a")!.revoked = false;
    const revokeRes = await fetch(`${baseUrl}/api/v1/devices/${alice.deviceId}/revoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tok("user-a")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ reason: "loss" }),
    });
    expect(revokeRes.status).toBe(200);

    const revDevPrep = await prepareEncryptedSend({
      conversationId: convId,
      senderDevice: alice,
      peerTarget: peerTargetB,
      plaintext: "After device revoked",
    });
    expect(revDevPrep.ok).toBe(true);
    if (!revDevPrep.ok) return;
    const revDevOut = await coordinator.submitPrepared(revDevPrep.prepared);
    expect(revDevOut.status).toBe("failed");
    expect(revDevOut.failureReason).toBe("device_revoked");
    expect(revDevOut.errorCode).toBe("DEVICE_REVOKED");
  });
});
