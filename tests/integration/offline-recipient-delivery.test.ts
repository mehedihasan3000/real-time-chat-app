import { createServer, type Server } from "node:http";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  encodeHistoryCursor,
  hasOnlyFields,
  type DevicePublicKeysResponse,
  type Envelope,
} from "@chat/contracts";
import { OlmAccountDevice, generateNonExtractableStorageKey } from "@chat/crypto";

import { createApp } from "../../apps/api/src/app.js";
import { createVerifier, mintTestToken } from "../../apps/api/src/auth/jwt.js";
import { clearSessionCache, type SessionRecord } from "../../apps/api/src/auth/session.js";
import { MemoryBlockStore } from "../../apps/api/src/blocks/store.js";
import { MemoryConversationStore } from "../../apps/api/src/conversations/index.js";
import { MemoryDeviceKeyStore } from "../../apps/api/src/keys/store.js";
import {
  MESSAGE_RETENTION_AUTO_EXPIRY_MS,
  MemoryMessageStore,
  MessageRateLimiter,
  OfflineRecipientDeliveryTracker,
} from "../../apps/api/src/messages/index.js";
import { MemoryProfileStore, type ProfileRecord } from "../../apps/api/src/profiles/store.js";
import {
  createLiveMessagePublisher,
  createSocketServer,
  type publishMessageNew,
} from "../../apps/api/src/socket/index.js";
import {
  ConversationsClient,
  HistoryClient,
  MessageSendClient,
  prepareEncryptedSend,
} from "../../apps/web/src/features/chat/index.js";
import {
  RealtimeClient,
  type RealtimeClientSnapshot,
  type RecipientDeliveryEvidence,
} from "../../apps/web/src/lib/realtime/index.js";

const ISS = "https://app.example.test";
const AUD = "https://api.example.test";

let server!: Server;
let ioServer: ReturnType<typeof createSocketServer> | null = null;
let boundPort = 0;
let baseUrl = "";
let keyPair!: Awaited<ReturnType<typeof mintTestToken>>["keyPair"];
let verifier!: ReturnType<typeof createVerifier>;

let tokens = new Map<string, string>();
let sessions = new Map<string, SessionRecord>();
let profileMap = new Map<string, ProfileRecord>();
let currentNow = new Date("2026-11-20T06:00:00.000Z");
let activeRecipientDevices = new Map<string, string | null>();

let blockStore = new MemoryBlockStore();
let conversationStore = new MemoryConversationStore();
let deviceKeyStore = new MemoryDeviceKeyStore();
let messageStore = new MemoryMessageStore();
let messageRateLimiter = new MessageRateLimiter();
let deliveryTracker = new OfflineRecipientDeliveryTracker();

const realtimeClients: RealtimeClient[] = [];
const olmDevices: OlmAccountDevice[] = [];

function tok(userId: string): string {
  const value = tokens.get(userId);
  if (!value) throw new Error(`Missing token for ${userId}`);
  return value;
}

const proxyOf = <T extends object>(getter: () => T): T =>
  new Proxy({} as T, {
    get(_target, prop) {
      const current = getter();
      const value = Reflect.get(current, prop, current);
      return typeof value === "function" ? value.bind(current) : value;
    },
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

const sessionLookup = async (sid: string) => sessions.get(sid) ?? null;
const conversationLookup = async (id: string) => conversationStore.getById(id);

function buildBackendStack() {
  let publishHook:
    | ((
        record: Parameters<typeof publishMessageNew>[1],
        conv: Parameters<typeof publishMessageNew>[2],
      ) => Promise<void>)
    | null = null;

  const app = createApp({
    verifier,
    sessionLookup,
    conversationLookup,
    conversationStore: proxyOf(() => conversationStore),
    messageStore: proxyOf(() => messageStore),
    messageRateLimiter: proxyOf(() => messageRateLimiter),
    onMessageCommitted: async (record, conversation) => {
      deliveryTracker.registerCommittedMessage(record, conversation);
      if (publishHook) {
        await publishHook(record, conversation);
      }
    },
    deviceKeyStore: proxyOf(() => deviceKeyStore),
    profileStore: profileStoreProxy,
    blockStore: proxyOf(() => blockStore),
    now: () => currentNow,
  });

  const nextServer = createServer(app);
  const nextIo = createSocketServer(nextServer, {
    verifier,
    sessionLookup,
    authorizer: {
      conversationLookup,
    },
    allowedOrigins: [ISS],
  });

  publishHook = createLiveMessagePublisher(nextIo, {
    conversationLookup,
    sessionLookup,
    deviceKeyStore: proxyOf(() => deviceKeyStore),
    blockStore: proxyOf(() => blockStore),
    requireConversationRoom: true,
    now: () => currentNow,
  });

  return { nextServer, nextIo };
}

async function restartBackendSamePort(): Promise<void> {
  if (ioServer) {
    await ioServer.close();
    ioServer = null;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const { nextServer, nextIo } = buildBackendStack();
  server = nextServer;
  ioServer = nextIo;

  await new Promise<void>((resolve) => server.listen(boundPort, "127.0.0.1", resolve));
}

async function seedUser(userId: string, sid: string, username: string, displayName: string) {
  const minted = await mintTestToken({
    sub: userId,
    sid,
    emailVerified: true,
    iss: ISS,
    aud: AUD,
    keyPair,
    expiresInSeconds: 300,
  });
  tokens.set(userId, minted.token);
  sessions.set(sid, {
    sid,
    userId,
    revoked: false,
    authenticatedAt: new Date(currentNow.getTime() - 60_000),
  });
  profileMap.set(userId, {
    userId,
    username,
    displayName,
    avatar: null,
    locale: "en",
    timeZone: "UTC",
  });
}

async function enrollOlmDevice(
  userId: string,
  deviceId: string,
  storageKey?: CryptoKey,
): Promise<OlmAccountDevice> {
  const device = await OlmAccountDevice.create({ deviceId, storageKey });
  olmDevices.push(device);
  const res = await fetch(`${baseUrl}/api/v1/devices/${encodeURIComponent(deviceId)}/keys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tok(userId)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      bundle: device.toPublicKeyBundle(),
    }),
  });
  expect(res.status).toBe(200);
  activeRecipientDevices.set(userId, deviceId);
  return device;
}

async function fetchPeerPublicKeys(
  requesterUserId: string,
  peerUserId: string,
): Promise<{ status: number; data: DevicePublicKeysResponse | null }> {
  const res = await fetch(
    `${baseUrl}/api/v1/devices/${encodeURIComponent(peerUserId)}/public-keys`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${tok(requesterUserId)}`,
      },
    },
  );
  const envelope = (await res.json()) as Envelope<DevicePublicKeysResponse>;
  return {
    status: res.status,
    data: envelope.ok ? envelope.data : null,
  };
}

function createBobRealtimeClient(
  conversationId: string,
  device: OlmAccountDevice | null,
): RealtimeClient {
  const client = new RealtimeClient({
    apiOrigin: baseUrl,
    accountId: "usr_bob",
    conversationId,
    device,
    tokenProvider: () => tok("usr_bob"),
    extraHeaders: { origin: ISS },
    transports: ["websocket"],
    now: () => currentNow,
    onDeliveryEvidence: (evidenceItems: readonly RecipientDeliveryEvidence[]) => {
      for (const item of evidenceItems) {
        deliveryTracker.recordDeliveryEvidence({
          messageId: item.messageId,
          actorUserId: item.recipientUserId,
          actorDeviceId: item.recipientDeviceId,
          decrypted: true,
          activeRecipientDeviceId: activeRecipientDevices.get(item.recipientUserId) ?? null,
          now: currentNow,
        });
      }
    },
  });
  realtimeClients.push(client);
  return client;
}

async function waitForClientCondition(
  client: RealtimeClient,
  predicate: (snapshot: RealtimeClientSnapshot) => boolean,
  timeoutMs = 5000,
): Promise<RealtimeClientSnapshot> {
  const current = client.getSnapshot();
  if (predicate(current)) {
    return current;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for realtime client snapshot condition"));
    }, timeoutMs);

    const unsubscribe = client.subscribe((snapshot: RealtimeClientSnapshot) => {
      if (predicate(snapshot)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(snapshot);
      }
    });
  });
}

beforeAll(async () => {
  const minted = await mintTestToken({
    sub: "bootstrap",
    sid: "boot",
    emailVerified: true,
    iss: ISS,
    aud: AUD,
  });
  keyPair = minted.keyPair;
  verifier = createVerifier({
    appOrigin: ISS,
    apiOrigin: AUD,
    resolveKey: (async () => keyPair.publicKey as never) as never,
  });

  const { nextServer, nextIo } = buildBackendStack();
  server = nextServer;
  ioServer = nextIo;

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  boundPort = addr.port;
  baseUrl = `http://127.0.0.1:${boundPort}`;
});

beforeEach(() => {
  clearSessionCache();
  tokens = new Map();
  sessions = new Map();
  profileMap = new Map();
  activeRecipientDevices = new Map();
  blockStore = new MemoryBlockStore();
  conversationStore = new MemoryConversationStore();
  deliveryTracker = new OfflineRecipientDeliveryTracker();
  deviceKeyStore = new MemoryDeviceKeyStore({
    deleteQueuedCiphertext: async (userId, deviceId) => {
      activeRecipientDevices.set(userId, null);
      const conversations = await conversationStore.listForUser(userId, {
        limit: 100,
        before: null,
      });
      await messageStore.deleteUndeliveredForRecipientDevice({
        conversationIds: conversations.items.map((conversation) => conversation.id),
        recipientUserId: userId,
        recipientDeviceId: deviceId,
        isDelivered: (messageId) => deliveryTracker.isDelivered(messageId),
      });
    },
  });
  messageStore = new MemoryMessageStore();
  messageRateLimiter = new MessageRateLimiter();
  currentNow = new Date("2026-11-20T06:00:00.000Z");
});

afterEach(() => {
  while (realtimeClients.length > 0) {
    realtimeClients.pop()?.dispose();
  }
  while (olmDevices.length > 0) {
    olmDevices.pop()?.dispose();
  }
});

afterAll(async () => {
  if (ioServer) {
    await ioServer.close();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("P2-10 — Offline recipient delivery integration (TC-CHAT-004, DEC-015, DEC-020, DEC-021, FR-SEC-010)", () => {
  it("TC-CHAT-004: queues ciphertext while Bob is offline, preserves across +45d clock advance and same-port backend restart, recovers without gap/duplication, and enforces monotonic opt-in receipts", async () => {
    expect(MESSAGE_RETENTION_AUTO_EXPIRY_MS).toBeNull();

    await seedUser("usr_alice", "sid_alice_t1", "alice_off", "Alice");
    await seedUser("usr_bob", "sid_bob_t1", "bob_off", "Bob");

    const aliceDevice = await enrollOlmDevice("usr_alice", "dev_alice_off_01");
    const bobStorageKey = await generateNonExtractableStorageKey();
    const bobDeviceInitial = await enrollOlmDevice("usr_bob", "dev_bob_off_02", bobStorageKey);

    const convClient = new ConversationsClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_alice",
      getToken: () => tok("usr_alice"),
    });
    const conversation = (await convClient.createOrGet("usr_bob")).conversation;

    // Fetch Bob's published key directory entry while Bob has zero active connections.
    const bobPublic = await fetchPeerPublicKeys("usr_alice", "usr_bob");
    expect(bobPublic.status).toBe(200);
    expect(bobPublic.data?.device.deviceId).toBe(bobDeviceInitial.deviceId);
    const bobDirectory = bobPublic.data!.device;

    const aliceSendClient = new MessageSendClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_alice",
      expectedDeviceId: aliceDevice.deviceId,
      getToken: () => tok("usr_alice"),
    });

    const msg1Text = "Offline queued #1 — বাংলা ক্ষ + emoji 💬🔐";
    const msg2Text = "Offline queued #2 — persisted across 45d outage";

    const send1 = await aliceSendClient.composeEncryptAndSend({
      conversationId: conversation.id,
      senderDevice: aliceDevice,
      peerTarget: {
        peerUserId: "usr_bob",
        peerDeviceId: bobDirectory.deviceId,
        peerIdentityKey: bobDirectory.identityKey,
        peerSenderKey: bobDirectory.senderKey,
        peerOneTimeOrFallbackKey: bobDirectory.oneTimeKeys[0]?.key ?? bobDirectory.fallbackKey.key,
      },
      plaintext: msg1Text,
    });
    expect(send1.ok).toBe(true);
    if (!send1.ok || send1.state.status !== "sent") return;

    currentNow = new Date(currentNow.getTime() + 2_000);
    const send2 = await aliceSendClient.composeEncryptAndSend({
      conversationId: conversation.id,
      senderDevice: aliceDevice,
      peerTarget: {
        peerUserId: "usr_bob",
        peerDeviceId: bobDirectory.deviceId,
        peerIdentityKey: bobDirectory.identityKey,
        peerSenderKey: bobDirectory.senderKey,
      },
      plaintext: msg2Text,
    });
    expect(send2.ok).toBe(true);
    if (!send2.ok || send2.state.status !== "sent") return;

    const msg1Id = send1.state.response.message.messageId;
    const msg2Id = send2.state.response.message.messageId;

    // Both messages sit at sender-only "sent" while Bob is disconnected.
    expect(deliveryTracker.getSenderView(msg1Id, "usr_alice")).toMatchObject({
      stage: "sent",
      deliveredAt: null,
      readAt: null,
      recipientDeviceId: bobDirectory.deviceId,
    });
    expect(deliveryTracker.getSenderView(msg1Id, "usr_bob")).toBeNull();
    expect(deliveryTracker.getSenderView(msg2Id, "usr_alice")?.stage).toBe("sent");

    // Advance clock +45 days (zero automatic TTL deletion under DEC-015) and restart backend on same port.
    currentNow = new Date(currentNow.getTime() + 45 * 24 * 60 * 60 * 1000);
    const preRestartHistory = new HistoryClient({
      apiOrigin: baseUrl,
      getToken: () => tok("usr_alice"),
    });
    const beforeRestartPage = await preRestartHistory.fetchPage({
      conversationId: conversation.id,
      after: encodeHistoryCursor(conversation.id, 0),
      limit: 50,
    });
    expect(beforeRestartPage.items.map((item) => item.seq)).toEqual([1, 2]);
    // Server never stores plaintext or private keys on any message record.
    for (const persisted of beforeRestartPage.items) {
      expect(
        hasOnlyFields(persisted as unknown as Record<string, unknown>, [
          "schemaVersion",
          "messageId",
          "conversationId",
          "seq",
          "senderUserId",
          "senderDeviceId",
          "clientMessageId",
          "encryptedEnvelope",
          "protocolVersion",
          "committedAt",
        ]),
      ).toBe(true);
    }

    await restartBackendSamePort();

    // Seal & restore Bob's Olm device state before Bob reconnects.
    const sealedBobState = await bobDeviceInitial.sealState();
    bobDeviceInitial.dispose();
    const unsealedBob = await OlmAccountDevice.unsealState(sealedBobState, bobStorageKey);
    expect(unsealedBob.ok).toBe(true);
    if (!unsealedBob.ok) return;
    olmDevices.push(unsealedBob.value);

    // Connect Bob's realtime client and race live msg 3 during catch-up.
    const bobClient = createBobRealtimeClient(conversation.id, unsealedBob.value);
    const msg3Text = "Live seq 3 racing Bob reconnect catch-up";

    const raceSendPromise = waitForClientCondition(
      bobClient,
      (snap) => snap.sync.phase === "buffering" || snap.sync.phase === "syncing",
    ).then(async () => {
      currentNow = new Date(currentNow.getTime() + 500);
      return aliceSendClient.composeEncryptAndSend({
        conversationId: conversation.id,
        senderDevice: aliceDevice,
        peerTarget: {
          peerUserId: "usr_bob",
          peerDeviceId: bobDirectory.deviceId,
          peerIdentityKey: bobDirectory.identityKey,
          peerSenderKey: bobDirectory.senderKey,
        },
        plaintext: msg3Text,
      });
    });

    const [, racedLiveSend] = await Promise.all([bobClient.connect(), raceSendPromise]);

    const synced = await waitForClientCondition(
      bobClient,
      (snap) => snap.sync.items.length === 3 && snap.connectionStatus === "connected",
    );

    expect(racedLiveSend.ok).toBe(true);
    if (!racedLiveSend.ok || racedLiveSend.state.status !== "sent") return;
    const msg3Id = racedLiveSend.state.response.message.messageId;

    expect(synced.sync.lastAppliedSeq).toBe(3);
    expect(synced.sync.items.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(synced.sync.items.every((item) => item.kind === "decrypted")).toBe(true);
    expect(
      synced.sync.items.map((item) => (item.kind === "decrypted" ? item.plaintext : "")),
    ).toEqual([msg1Text, msg2Text, msg3Text]);

    // Delivery receipts only advance to "delivered" after Bob's device decrypted them.
    expect(deliveryTracker.getSenderView(msg1Id, "usr_alice")?.stage).toBe("delivered");
    expect(deliveryTracker.getSenderView(msg2Id, "usr_alice")?.stage).toBe("delivered");
    expect(deliveryTracker.getSenderView(msg3Id, "usr_alice")?.stage).toBe("delivered");
    expect(deliveryTracker.getSenderView(msg1Id, "usr_bob")).toBeNull();

    // DEC-020: Read receipts remain opt-in, reciprocal, and require focused conversation render.
    const defaultOffRead = deliveryTracker.recordReadEvidence({
      messageId: msg1Id,
      actorUserId: "usr_bob",
      actorDeviceId: unsealedBob.value.deviceId,
      decrypted: true,
      activeRecipientDeviceId: unsealedBob.value.deviceId,
      displayedInFocusedConversation: true,
      recipientReadSharingEnabled: false,
      senderReadSharingEnabled: true,
      now: currentNow,
    });
    expect(defaultOffRead.ok && defaultOffRead.suppressedRead).toBe(true);
    expect(deliveryTracker.getSenderView(msg1Id, "usr_alice")?.stage).toBe("delivered");

    const backgroundRead = deliveryTracker.recordReadEvidence({
      messageId: msg1Id,
      actorUserId: "usr_bob",
      actorDeviceId: unsealedBob.value.deviceId,
      decrypted: true,
      activeRecipientDeviceId: unsealedBob.value.deviceId,
      displayedInFocusedConversation: false,
      recipientReadSharingEnabled: true,
      senderReadSharingEnabled: true,
      now: currentNow,
    });
    expect(backgroundRead.ok && backgroundRead.suppressedRead).toBe(true);
    expect(deliveryTracker.getSenderView(msg1Id, "usr_alice")?.stage).toBe("delivered");

    const oneSidedRead = deliveryTracker.recordReadEvidence({
      messageId: msg1Id,
      actorUserId: "usr_bob",
      actorDeviceId: unsealedBob.value.deviceId,
      decrypted: true,
      activeRecipientDeviceId: unsealedBob.value.deviceId,
      displayedInFocusedConversation: true,
      recipientReadSharingEnabled: true,
      senderReadSharingEnabled: false,
      now: currentNow,
    });
    expect(oneSidedRead.ok && oneSidedRead.suppressedRead).toBe(true);
    expect(deliveryTracker.getSenderView(msg1Id, "usr_alice")?.stage).toBe("delivered");

    const readNow = new Date(currentNow.getTime() + 1_500);
    const reciprocalRead = deliveryTracker.recordReadEvidence({
      messageId: msg1Id,
      actorUserId: "usr_bob",
      actorDeviceId: unsealedBob.value.deviceId,
      decrypted: true,
      activeRecipientDeviceId: unsealedBob.value.deviceId,
      displayedInFocusedConversation: true,
      recipientReadSharingEnabled: true,
      senderReadSharingEnabled: true,
      now: readNow,
    });
    expect(reciprocalRead.ok && reciprocalRead.advanced).toBe(true);
    expect(deliveryTracker.getSenderView(msg1Id, "usr_alice")).toMatchObject({
      stage: "read",
      readAt: readNow.toISOString(),
    });

    // Repeat delivery evidence never regresses "read" back to "delivered".
    deliveryTracker.recordDeliveryEvidence({
      messageId: msg1Id,
      actorUserId: "usr_bob",
      actorDeviceId: unsealedBob.value.deviceId,
      decrypted: true,
      activeRecipientDeviceId: unsealedBob.value.deviceId,
      now: new Date(readNow.getTime() + 5_000),
    });
    expect(deliveryTracker.getSenderView(msg1Id, "usr_alice")?.stage).toBe("read");
  });

  it("FR-SEC-010 & DEC-004/015: purges undelivered ciphertext for revoked device, hides 404 key lookup, blocks unaccepted peer key change, shows missing-key for pre-replacement history, and isolates account deletions", async () => {
    await seedUser("usr_alice", "sid_alice_t2", "alice_sec", "Alice");
    await seedUser("usr_bob", "sid_bob_t2", "bob_sec", "Bob");

    const aliceDevice = await enrollOlmDevice("usr_alice", "dev_alice_sec_01");
    const bobDevice1 = await enrollOlmDevice("usr_bob", "dev_bob_offline_rev_1");

    const convClient = new ConversationsClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_alice",
      getToken: () => tok("usr_alice"),
    });
    const conversation = (await convClient.createOrGet("usr_bob")).conversation;

    const bob1Bundle = bobDevice1.toPublicKeyBundle();
    const aliceSendClient = new MessageSendClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_alice",
      expectedDeviceId: aliceDevice.deviceId,
      getToken: () => tok("usr_alice"),
    });

    // seq 1: Delivered to bobDevice1 while online.
    const send1 = await aliceSendClient.composeEncryptAndSend({
      conversationId: conversation.id,
      senderDevice: aliceDevice,
      peerTarget: {
        peerUserId: "usr_bob",
        peerDeviceId: bob1Bundle.deviceId,
        peerIdentityKey: bob1Bundle.identityKey,
        peerSenderKey: bob1Bundle.senderKey,
        peerOneTimeOrFallbackKey: bob1Bundle.oneTimeKeys[0]!.key,
      },
      plaintext: "Delivered before revocation (seq 1)",
    });
    expect(send1.ok).toBe(true);
    if (!send1.ok || send1.state.status !== "sent") return;
    const msg1Id = send1.state.response.message.messageId;

    const bobClient1 = createBobRealtimeClient(conversation.id, bobDevice1);
    await bobClient1.connect();
    await waitForClientCondition(
      bobClient1,
      (snap) => snap.sync.items.length === 1 && snap.connectionStatus === "connected",
    );
    expect(deliveryTracker.getSenderView(msg1Id, "usr_alice")?.stage).toBe("delivered");

    // Bob goes offline cleanly; Alice queues seq 2 for bobDevice1 while undelivered.
    bobClient1.dispose();

    const send2 = await aliceSendClient.composeEncryptAndSend({
      conversationId: conversation.id,
      senderDevice: aliceDevice,
      peerTarget: {
        peerUserId: "usr_bob",
        peerDeviceId: bob1Bundle.deviceId,
        peerIdentityKey: bob1Bundle.identityKey,
        peerSenderKey: bob1Bundle.senderKey,
      },
      plaintext: "Queued undelivered for revoked device (seq 2)",
    });
    expect(send2.ok).toBe(true);
    if (!send2.ok || send2.state.status !== "sent") return;
    const msg2Id = send2.state.response.message.messageId;
    expect(deliveryTracker.getSenderView(msg2Id, "usr_alice")?.stage).toBe("sent");

    // Revoke bobDevice1 -> triggers deleteQueuedCiphertext -> purges undelivered seq 2 only.
    const revokeRes = await fetch(
      `${baseUrl}/api/v1/devices/${encodeURIComponent(bobDevice1.deviceId)}/revoke`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tok("usr_bob")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: "loss" }),
      },
    );
    expect(revokeRes.status).toBe(200);

    // Public key lookup now fails closed (404).
    const revokedKeysLookup = await fetchPeerPublicKeys("usr_alice", "usr_bob");
    expect(revokedKeysLookup.status).toBe(404);

    // Delivered seq 1 survives in history; undelivered seq 2 was purged.
    const historyCheck = await messageStore.listByConversation(conversation.id);
    expect(historyCheck.map((item) => item.id)).toEqual([msg1Id]);

    // Bob enrolls replacement device bobDevice2.
    const bobDevice2 = await enrollOlmDevice("usr_bob", "dev_bob_offline_rep_2");
    const bob2Client = createBobRealtimeClient(conversation.id, bobDevice2);
    await bob2Client.connect();
    const afterReplacementSnap = await waitForClientCondition(
      bob2Client,
      (snap) => snap.sync.items.length === 1 && snap.connectionStatus === "connected",
    );

    // Old seq 1 renders fail-closed missing-key placeholder without receipt eligibility.
    const legacyItem = afterReplacementSnap.sync.items[0]!;
    expect(legacyItem.kind).toBe("decryption_failed");
    if (legacyItem.kind === "decryption_failed") {
      expect(legacyItem.failureState).toBe("missing-key");
      expect(legacyItem.code).toBe("MISSING_KEY_MATERIAL");
      expect(legacyItem.canEmitDeliveryReceipt).toBe(false);
      expect(legacyItem.canEmitReadReceipt).toBe(false);
    }
    expect(bob2Client.getDeliveryEvidence()).toEqual([]);

    // Alice fetches Bob's new active device keys -> prepareEncryptedSend blocks until explicit key acceptance.
    const replacementLookup = await fetchPeerPublicKeys("usr_alice", "usr_bob");
    expect(replacementLookup.status).toBe(200);
    const bob2Directory = replacementLookup.data!.device;
    expect(bob2Directory.deviceId).toBe(bobDevice2.deviceId);

    const blockedPrep = await prepareEncryptedSend({
      conversationId: conversation.id,
      senderDevice: aliceDevice,
      peerTarget: {
        peerUserId: "usr_bob",
        peerDeviceId: bob2Directory.deviceId,
        peerIdentityKey: bob2Directory.identityKey,
        peerSenderKey: bob2Directory.senderKey,
        peerOneTimeOrFallbackKey:
          bob2Directory.oneTimeKeys[0]?.key ?? bob2Directory.fallbackKey.key,
      },
      plaintext: "Should be blocked until peer key accepted",
    });
    expect(blockedPrep.ok).toBe(false);
    if (!blockedPrep.ok) {
      expect(blockedPrep.failure.code).toBe("PEER_KEY_CHANGE_BLOCKED");
    }

    // Explicitly accept changed identity key and send seq 3 to replacement device.
    aliceDevice.peerKeyGuard.accept("usr_bob");
    const send3 = await aliceSendClient.composeEncryptAndSend({
      conversationId: conversation.id,
      senderDevice: aliceDevice,
      peerTarget: {
        peerUserId: "usr_bob",
        peerDeviceId: bob2Directory.deviceId,
        peerIdentityKey: bob2Directory.identityKey,
        peerSenderKey: bob2Directory.senderKey,
        peerOneTimeOrFallbackKey:
          bob2Directory.oneTimeKeys[0]?.key ?? bob2Directory.fallbackKey.key,
      },
      plaintext: "Post-replacement verified message (seq 3)",
    });
    expect(send3.ok).toBe(true);
    if (!send3.ok || send3.state.status !== "sent") return;
    const msg3Id = send3.state.response.message.messageId;

    const postSend3Snap = await waitForClientCondition(
      bob2Client,
      (snap) => snap.sync.items.length === 2,
    );
    const receivedNew = postSend3Snap.sync.items.find((item) => item.messageId === msg3Id);
    expect(receivedNew?.kind).toBe("decrypted");
    if (receivedNew?.kind === "decrypted") {
      expect(receivedNew.plaintext).toBe("Post-replacement verified message (seq 3)");
    }
    expect(deliveryTracker.getSenderView(msg3Id, "usr_alice")?.stage).toBe("delivered");

    // DEC-015 account-deletion isolation: deleting Alice's sent messages leaves Bob's reply intact.
    const bobSendClient = new MessageSendClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_bob",
      expectedDeviceId: bobDevice2.deviceId,
      getToken: () => tok("usr_bob"),
    });
    const aliceBundle = aliceDevice.toPublicKeyBundle();
    const bobReply = await bobSendClient.composeEncryptAndSend({
      conversationId: conversation.id,
      senderDevice: bobDevice2,
      peerTarget: {
        peerUserId: "usr_alice",
        peerDeviceId: aliceBundle.deviceId,
        peerIdentityKey: aliceBundle.identityKey,
        peerSenderKey: aliceBundle.senderKey,
        peerOneTimeOrFallbackKey: aliceBundle.oneTimeKeys[0]!.key,
      },
      plaintext: "Bob's reply must survive Alice account purge",
    });
    expect(bobReply.ok).toBe(true);
    if (!bobReply.ok || bobReply.state.status !== "sent") return;

    const deletedAliceCount = await messageStore.deleteBySenderUserId("usr_alice");
    expect(deletedAliceCount).toBe(2); // seq 1 and seq 3
    const surviving = await messageStore.listByConversation(conversation.id);
    expect(surviving.map((item) => item.id)).toEqual([bobReply.state.response.message.messageId]);
  });

  it("recovers locked-device reconnect catch-up items in-place via setDevice() + retryRecoverableMessages() and emits delivery evidence only after unlock", async () => {
    await seedUser("usr_alice", "sid_alice_t3", "alice_lock", "Alice");
    await seedUser("usr_bob", "sid_bob_t3", "bob_lock", "Bob");

    const aliceDevice = await enrollOlmDevice("usr_alice", "dev_alice_lock_01");
    const bobStorageKey = await generateNonExtractableStorageKey();
    const bobDevice = await enrollOlmDevice("usr_bob", "dev_bob_lock_02", bobStorageKey);

    const convClient = new ConversationsClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_alice",
      getToken: () => tok("usr_alice"),
    });
    const conversation = (await convClient.createOrGet("usr_bob")).conversation;

    const bobBundle = bobDevice.toPublicKeyBundle();
    const aliceSendClient = new MessageSendClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_alice",
      expectedDeviceId: aliceDevice.deviceId,
      getToken: () => tok("usr_alice"),
    });

    const msg1 = await aliceSendClient.composeEncryptAndSend({
      conversationId: conversation.id,
      senderDevice: aliceDevice,
      peerTarget: {
        peerUserId: "usr_bob",
        peerDeviceId: bobBundle.deviceId,
        peerIdentityKey: bobBundle.identityKey,
        peerSenderKey: bobBundle.senderKey,
        peerOneTimeOrFallbackKey: bobBundle.oneTimeKeys[0]!.key,
      },
      plaintext: "Locked catch-up item 1",
    });
    const msg2 = await aliceSendClient.composeEncryptAndSend({
      conversationId: conversation.id,
      senderDevice: aliceDevice,
      peerTarget: {
        peerUserId: "usr_bob",
        peerDeviceId: bobBundle.deviceId,
        peerIdentityKey: bobBundle.identityKey,
        peerSenderKey: bobBundle.senderKey,
      },
      plaintext: "Locked catch-up item 2",
    });
    expect(msg1.ok && msg2.ok).toBe(true);
    if (!msg1.ok || msg1.state.status !== "sent" || !msg2.ok || msg2.state.status !== "sent") {
      return;
    }
    const msg1Id = msg1.state.response.message.messageId;
    const msg2Id = msg2.state.response.message.messageId;

    // Seal Bob's device to simulate local key store remaining locked on reconnect.
    const sealed = await bobDevice.sealState();
    bobDevice.dispose();

    const bobClient = createBobRealtimeClient(conversation.id, null);
    await bobClient.connect();
    const lockedSnap = await waitForClientCondition(
      bobClient,
      (snap) => snap.sync.items.length === 2 && snap.connectionStatus === "connected",
    );

    expect(
      lockedSnap.sync.items.every(
        (item) =>
          item.kind === "decryption_failed" &&
          item.failureState === "missing-key" &&
          item.recoverable === true &&
          item.canEmitDeliveryReceipt === false &&
          item.canEmitReadReceipt === false,
      ),
    ).toBe(true);
    expect(bobClient.getDeliveryEvidence()).toEqual([]);
    expect(deliveryTracker.getSenderView(msg1Id, "usr_alice")?.stage).toBe("sent");
    expect(deliveryTracker.getSenderView(msg2Id, "usr_alice")?.stage).toBe("sent");

    // Unlock sealed device state and recover placeholders without re-fetching HTTP history.
    const unlocked = await OlmAccountDevice.unsealState(sealed, bobStorageKey);
    expect(unlocked.ok).toBe(true);
    if (!unlocked.ok) return;
    olmDevices.push(unlocked.value);

    bobClient.setDevice(unlocked.value);
    const retryResult = await bobClient.retryRecoverableMessages();
    expect(retryResult.stale).toBe(false);
    expect(retryResult.retriedCount).toBe(2);
    expect(retryResult.decryptedCount).toBe(2);
    expect(retryResult.stillFailedCount).toBe(0);
    expect(retryResult.deliveryEvidence.length).toBe(2);

    const unlockedSnap = bobClient.getSnapshot();
    expect(
      unlockedSnap.sync.items.map((item) => (item.kind === "decrypted" ? item.plaintext : "")),
    ).toEqual(["Locked catch-up item 1", "Locked catch-up item 2"]);
    expect(deliveryTracker.getSenderView(msg1Id, "usr_alice")?.stage).toBe("delivered");
    expect(deliveryTracker.getSenderView(msg2Id, "usr_alice")?.stage).toBe("delivered");
  });
});
