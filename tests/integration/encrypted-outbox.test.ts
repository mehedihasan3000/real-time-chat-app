import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type DevicePublicKeysResponse } from "@chat/contracts";
import {
  OlmAccountDevice,
  createInMemoryIdbFactory,
  createSharedFakeLockManager,
  type OlmEncryptedEnvelope,
  type OlmPeerTarget,
} from "@chat/crypto";

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
  EncryptedIndexedDbOutboxStorageAdapter,
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

describe("P2-09 integration — Live API + Olm WASM + IndexedDB encrypted outbox", () => {
  it("persists encrypted Olm send offline with zero plaintext at rest, survives dropped-ack + reload, and reconciles cleanly via server idempotency (TC-CHAT-005, DATA-013)", async () => {
    const alice = await enrollOlmDevice("user-a", "dev-p209-alice-01");
    const bob = await enrollOlmDevice("user-b", "dev-p209-bob-01");
    const convClient = new ConversationsClient({
      apiOrigin: baseUrl,
      expectedUserId: "user-a",
      getToken: () => tok("user-a"),
    });
    const convId = (await convClient.createOrGet("user-b")).conversation.id;
    const peerTargetB = await fetchPeerTarget("user-a", "user-b");

    const idbFactory = createInMemoryIdbFactory();
    const lockManager = createSharedFakeLockManager();
    const storage1 = new EncryptedIndexedDbOutboxStorageAdapter({
      idbFactory,
      lockManager,
      forbiddenReuseKeys: [alice.storageKey],
    });

    const plaintextMarker = "নির্ভরযোগ্য আউটবক্স 🔐 <script>alert(1)</script> MARKER_P209_LIVE";
    const prep = await prepareEncryptedSend({
      conversationId: convId,
      senderDevice: alice,
      peerTarget: peerTargetB,
      plaintext: plaintextMarker,
    });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;

    const coordinator1 = new SendOutboxCoordinator({
      accountId: "user-a",
      activeConversationId: convId,
      sender: new MessageSendClient({
        apiOrigin: baseUrl,
        expectedUserId: "user-a",
        expectedDeviceId: alice.deviceId,
        getToken: () => tok("user-a"),
      }),
      storage: storage1,
      online: false,
      nowMs: () => 1_763_600_100_000,
      scheduleTimer: () => 0,
      cancelTimer: () => {},
    });

    await coordinator1.submitPrepared(prep.prepared);

    // Inspect persisted IndexedDB records: zero plaintext and zero unsealed envelope
    const atRest = await storage1.inspectAtRest("user-a");
    expect(atRest.hasKey).toBe(true);
    expect(atRest.keyExtractable).toBe(false);
    expect(atRest.sealedEntries).toHaveLength(1);
    const dumped = JSON.stringify(atRest);
    expect(dumped).not.toContain("MARKER_P209_LIVE");
    expect(dumped).not.toContain(prep.prepared.payload.encryptedEnvelope);

    // Inject dropped 201 ack once on commit
    let dropAckOnce = true;
    messageStore = new MemoryMessageStore({
      afterInsertBeforeAck: () => {
        if (dropAckOnce) {
          dropAckOnce = false;
          throw new Error("Simulated dropped 201 ack after commit");
        }
      },
    });
    await coordinator1.setOnline(true);
    const unknownEntry = coordinator1.getSnapshot().entriesForActiveConversation[0]!;
    expect(unknownEntry.status).toBe("unknown");
    expect(await messageStore.listByConversation(convId)).toHaveLength(1);

    // Full browser reload into brand-new adapter + coordinator over same IndexedDB
    const storage2 = new EncryptedIndexedDbOutboxStorageAdapter({
      idbFactory,
      lockManager,
      forbiddenReuseKeys: [alice.storageKey],
    });
    const coordinator2 = new SendOutboxCoordinator({
      accountId: "user-a",
      activeConversationId: convId,
      sender: new MessageSendClient({
        apiOrigin: baseUrl,
        expectedUserId: "user-a",
        expectedDeviceId: alice.deviceId,
        getToken: () => tok("user-a"),
      }),
      storage: storage2,
      online: false,
      nowMs: () => 1_763_600_105_000,
      scheduleTimer: () => 0,
      cancelTimer: () => {},
    });

    await coordinator2.reconcileAfterReload();
    const afterReload = coordinator2.getSnapshot().entriesForActiveConversation[0]!;
    expect(afterReload.status).toBe("unknown");
    expect(afterReload.clientMessageId).toBe(prep.prepared.payload.clientMessageId);

    // Reconnect reconciles via idempotency to seq 1 (no duplicate DB row) & clears IndexedDB outbox_entries
    await coordinator2.setOnline(true);
    const settled = coordinator2.getSnapshot().entriesForActiveConversation[0]!;
    expect(settled.status).toBe("sent");
    expect(settled.committedSeq).toBe(1);
    expect((await storage2.inspectAtRest("user-a")).sealedEntries).toHaveLength(0);

    const rows = await messageStore.listByConversation(convId);
    expect(rows).toHaveLength(1);
    const decrypted = await bob.decryptEnvelope(wireFromStored(rows[0]!), {
      expectedRecipientDeviceId: bob.deviceId,
      peerUserId: "user-a",
      expectedPeerIdentityKey: alice.toPublicKeyBundle().identityKey,
    });
    expect(decrypted.ok).toBe(true);
    if (decrypted.ok) {
      expect(decrypted.value.plaintext).toBe(plaintextMarker);
    }
  });

  it("deduplicates concurrent two-tab flushes against the live Express server via Web Locks", async () => {
    const alice = await enrollOlmDevice("user-a", "dev-p209-alice-tab");
    await enrollOlmDevice("user-b", "dev-p209-bob-tab");
    const convClient = new ConversationsClient({
      apiOrigin: baseUrl,
      expectedUserId: "user-a",
      getToken: () => tok("user-a"),
    });
    const convId = (await convClient.createOrGet("user-b")).conversation.id;
    const peerTargetB = await fetchPeerTarget("user-a", "user-b");

    const prep = await prepareEncryptedSend({
      conversationId: convId,
      senderDevice: alice,
      peerTarget: peerTargetB,
      plaintext: "Two-tab Web Locks race test",
    });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;

    const idbFactory = createInMemoryIdbFactory();
    const lockManager = createSharedFakeLockManager();
    let httpPosts = 0;

    const countingFetch: typeof fetch = async (input, init) => {
      httpPosts += 1;
      return fetch(input, init);
    };

    const tab1 = new SendOutboxCoordinator({
      accountId: "user-a",
      activeConversationId: convId,
      sender: new MessageSendClient({
        apiOrigin: baseUrl,
        expectedUserId: "user-a",
        expectedDeviceId: alice.deviceId,
        getToken: () => tok("user-a"),
        fetchImpl: countingFetch,
      }),
      storage: new EncryptedIndexedDbOutboxStorageAdapter({ idbFactory, lockManager }),
      online: false,
      nowMs: () => 1_763_600_200_000,
      scheduleTimer: () => 0,
      cancelTimer: () => {},
    });
    const tab2 = new SendOutboxCoordinator({
      accountId: "user-a",
      activeConversationId: convId,
      sender: new MessageSendClient({
        apiOrigin: baseUrl,
        expectedUserId: "user-a",
        expectedDeviceId: alice.deviceId,
        getToken: () => tok("user-a"),
        fetchImpl: countingFetch,
      }),
      storage: new EncryptedIndexedDbOutboxStorageAdapter({ idbFactory, lockManager }),
      online: false,
      nowMs: () => 1_763_600_200_000,
      scheduleTimer: () => 0,
      cancelTimer: () => {},
    });

    await tab1.submitPrepared(prep.prepared);
    await tab2.hydrate();

    await Promise.all([tab1.setOnline(true), tab2.setOnline(true)]);

    expect(httpPosts).toBe(1);
    expect(await messageStore.listByConversation(convId)).toHaveLength(1);
    expect(tab1.getSnapshot().entriesForActiveConversation[0]!.status).toBe("sent");
    expect(tab2.getSnapshot().entriesForActiveConversation[0]!.status).toBe("sent");
    expect(tab1.getSnapshot().entriesForActiveConversation[0]!.committedSeq).toBe(1);
    expect(tab2.getSnapshot().entriesForActiveConversation[0]!.committedSeq).toBe(1);
  });

  it("purges queued ciphertext on device revocation and removes key + entries on confirmed logout", async () => {
    const alice = await enrollOlmDevice("user-a", "dev-p209-alice-rev");
    await enrollOlmDevice("user-b", "dev-p209-bob-rev");
    const convClient = new ConversationsClient({
      apiOrigin: baseUrl,
      expectedUserId: "user-a",
      getToken: () => tok("user-a"),
    });
    const convId = (await convClient.createOrGet("user-b")).conversation.id;
    const peerTargetB = await fetchPeerTarget("user-a", "user-b");

    const idbFactory = createInMemoryIdbFactory();
    const lockManager = createSharedFakeLockManager();
    const storage = new EncryptedIndexedDbOutboxStorageAdapter({ idbFactory, lockManager });
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
      online: false,
      nowMs: () => 1_763_600_300_000,
      scheduleTimer: () => 0,
      cancelTimer: () => {},
    });

    const p1 = await prepareEncryptedSend({
      conversationId: convId,
      senderDevice: alice,
      peerTarget: peerTargetB,
      plaintext: "Pending before revocation",
    });
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;

    await coordinator.submitPrepared(p1.prepared);
    expect((await storage.inspectAtRest("user-a")).sealedEntries).toHaveLength(1);

    // Revoke device on API and in outbox -> UI shows failed/device_revoked, IndexedDB purges queued ciphertext
    const revokeRes = await fetch(`${baseUrl}/api/v1/devices/${alice.deviceId}/revoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tok("user-a")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ reason: "loss" }),
    });
    expect(revokeRes.status).toBe(200);

    await coordinator.onDeviceRevoked();
    expect(coordinator.getSnapshot().entriesForActiveConversation[0]!.failureReason).toBe(
      "device_revoked",
    );
    expect((await storage.inspectAtRest("user-a")).sealedEntries).toHaveLength(0);

    // Confirmed logout wipes CryptoKey and metadata as well
    const logoutDone = await coordinator.requestLogout({ confirmDiscardPending: true });
    expect(logoutDone.completed).toBe(true);
    const restAfterLogout = await storage.inspectAtRest("user-a");
    expect(restAfterLogout.hasKey).toBe(false);
    expect(restAfterLogout.meta).toBeNull();
  });
});
