import { createServer, type Server } from "node:http";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PUBLIC_FIELDS, hasOnlyFields, type HistoryMessageItem } from "@chat/contracts";
import { OlmAccountDevice } from "@chat/crypto";

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
  createLiveMessagePublisher,
  createSocketServer,
  disconnectRevokedSessionSockets,
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
} from "../../apps/web/src/lib/realtime/index.js";

const ISS = "https://app.example.test";
const AUD = "https://api.example.test";

let keyPair!: Awaited<ReturnType<typeof mintTestToken>>["keyPair"];

let tokens = new Map<string, string>();
let sessions = new Map<string, SessionRecord>();
let profileMap = new Map<string, ProfileRecord>();
let currentNow = new Date();

let blockStore = new MemoryBlockStore();
let conversationStore = new MemoryConversationStore();
let deviceKeyStore = new MemoryDeviceKeyStore();
let messageStore = new MemoryMessageStore();
let messageRateLimiter = new MessageRateLimiter();

const activeServers: Server[] = [];
const activeIoServers: Array<ReturnType<typeof createSocketServer>> = [];
const activeClients: RealtimeClient[] = [];
const activeDevices: OlmAccountDevice[] = [];

function tok(userId: string): string {
  const value = tokens.get(userId);
  if (!value) throw new Error(`Missing token for ${userId}`);
  return value;
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
  baseUrl: string,
  userId: string,
  deviceId: string,
): Promise<OlmAccountDevice> {
  const device = await OlmAccountDevice.create({ deviceId });
  activeDevices.push(device);
  const res = await fetch(`${baseUrl}/api/v1/devices/${encodeURIComponent(deviceId)}/keys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tok(userId)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ bundle: device.toPublicKeyBundle() }),
  });
  expect(res.status).toBe(200);
  return device;
}

async function sendEncryptedText(
  baseUrl: string,
  senderUserId: string,
  senderDevice: OlmAccountDevice,
  recipientUserId: string,
  recipientDevice: OlmAccountDevice,
  conversationId: string,
  plaintext: string,
) {
  const bundle = recipientDevice.toPublicKeyBundle();
  const preKey = bundle.oneTimeKeys[0]?.key ?? bundle.fallbackKey.key;
  const prepared = await prepareEncryptedSend({
    conversationId,
    senderDevice,
    peerTarget: {
      peerUserId: recipientUserId,
      peerDeviceId: recipientDevice.deviceId,
      peerIdentityKey: recipientDevice.identityKey,
      peerSenderKey: recipientDevice.senderKey,
      peerOneTimeOrFallbackKey: preKey,
    },
    plaintext,
  });
  if (!prepared.ok) throw new Error(prepared.failure.message);
  const client = new MessageSendClient({
    apiOrigin: baseUrl,
    expectedUserId: senderUserId,
    expectedDeviceId: senderDevice.deviceId,
    getToken: () => tok(senderUserId),
  });
  return client.sendPrepared(prepared.prepared);
}

interface TestBackendInstance {
  httpServer: Server;
  ioServer: ReturnType<typeof createSocketServer>;
  baseUrl: string;
  port: number;
  close(): Promise<void>;
}

async function startBackend(options?: {
  listenPort?: number;
  shouldPublishLive?: (record: MessageRecord) => boolean;
}): Promise<TestBackendInstance> {
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

  const sessionLookup = async (sid: string) => sessions.get(sid) ?? null;
  const conversationLookup = async (id: string) => conversationStore.getById(id);

  let publishHook:
    | ((
        record: MessageRecord,
        conv: Awaited<ReturnType<typeof conversationStore.getById>> & {},
      ) => Promise<void>)
    | null = null;

  const app = createApp({
    verifier,
    sessionLookup,
    conversationLookup,
    conversationStore,
    messageStore,
    messageRateLimiter,
    onMessageCommitted: async (record, conversation) => {
      if (options?.shouldPublishLive && !options.shouldPublishLive(record)) {
        return;
      }
      if (publishHook) {
        await publishHook(record, conversation);
      }
    },
    deviceKeyStore,
    profileStore: profileStoreProxy,
    blockStore,
    now: () => currentNow,
  });

  const httpServer = createServer(app);
  const ioServer = createSocketServer(httpServer, {
    verifier,
    sessionLookup,
    authorizer: { conversationLookup },
    allowedOrigins: [ISS],
  });

  publishHook = createLiveMessagePublisher(ioServer, {
    conversationLookup,
    sessionLookup,
    deviceKeyStore,
    blockStore,
    requireConversationRoom: true,
    now: () => currentNow,
  });

  activeServers.push(httpServer);
  activeIoServers.push(ioServer);

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options?.listenPort ?? 0, "127.0.0.1", () => resolve());
  });
  const addr = httpServer.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    httpServer,
    ioServer,
    baseUrl,
    port: addr.port,
    close: async () => {
      await ioServer.close();
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function waitUntilSnapshot(
  client: RealtimeClient,
  predicate: (snap: RealtimeClientSnapshot) => boolean,
  timeoutMs = 8_000,
): Promise<RealtimeClientSnapshot> {
  const initial = client.getSnapshot();
  if (predicate(initial)) return Promise.resolve(initial);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(
        new Error(
          `Timed out waiting for RealtimeClient snapshot. Current=${JSON.stringify({
            status: client.getSnapshot().connectionStatus,
            phase: client.getSnapshot().sync.phase,
            seq: client.getSnapshot().sync.lastAppliedSeq,
            count: client.getSnapshot().sync.items.length,
          })}`,
        ),
      );
    }, timeoutMs);
    const unsub = client.subscribe((snap) => {
      if (predicate(snap)) {
        clearTimeout(timer);
        unsub();
        resolve(snap);
      }
    });
  });
}

beforeAll(async () => {
  const jose = await import("jose");
  const kp = (await jose.generateKeyPair("Ed25519", {
    extractable: true,
  })) as unknown as Awaited<ReturnType<typeof mintTestToken>>["keyPair"];
  keyPair = { ...kp, kid: "test-p208-kid" };
});

beforeEach(() => {
  clearSessionCache();
  tokens = new Map();
  sessions = new Map();
  profileMap = new Map();
  blockStore = new MemoryBlockStore();
  conversationStore = new MemoryConversationStore();
  deviceKeyStore = new MemoryDeviceKeyStore();
  messageStore = new MemoryMessageStore();
  messageRateLimiter = new MessageRateLimiter();
  currentNow = new Date();
});

afterEach(async () => {
  while (activeClients.length > 0) {
    activeClients.pop()?.dispose();
  }
  while (activeIoServers.length > 0) {
    await activeIoServers
      .pop()
      ?.close()
      .catch(() => undefined);
  }
  while (activeServers.length > 0) {
    const srv = activeServers.pop()!;
    srv.closeAllConnections?.();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (activeDevices.length > 0) {
    activeDevices.pop()?.dispose();
  }
});

describe("P2-08 — Live Socket.IO + HTTP catch-up integration (TC-HIST-002, FR-AUTH-007, FR-CHAT-012, FR-HIST-003)", () => {
  it("catches up offline messages on reconnect and merges live message:new arriving between subscribe and HTTP fetch without loss or duplication", async () => {
    const backend = await startBackend();

    await seedUser("usr_alice", "sid_alice", "alice_rc", "Alice");
    await seedUser("usr_bob", "sid_bob", "bob_rc", "Bob");

    const aliceDevice = await enrollOlmDevice(backend.baseUrl, "usr_alice", "dev_alice_rc_01");
    const bobDevice = await enrollOlmDevice(backend.baseUrl, "usr_bob", "dev_bob_rc_02");

    const convClient = new ConversationsClient({
      apiOrigin: backend.baseUrl,
      expectedUserId: "usr_alice",
      getToken: () => tok("usr_alice"),
    });
    const conversationId = (await convClient.createOrGet("usr_bob")).conversation.id;

    let releaseCatchUpFetch: (() => void) | null = null;
    let interceptNextNonEmptyCatchUp = false;
    const rawHistoryClient = new HistoryClient({
      apiOrigin: backend.baseUrl,
      getToken: () => tok("usr_bob"),
    });

    const racingHistoryClient = {
      async fetchPage(input: Parameters<HistoryClient["fetchPage"]>[0]) {
        const res = await rawHistoryClient.fetchPage(input);
        if (interceptNextNonEmptyCatchUp) {
          interceptNextNonEmptyCatchUp = false;
          // Delay returning HTTP catch-up page until live seq 5 fires AFTER subscribe!
          await new Promise<void>((resolve) => {
            releaseCatchUpFetch = resolve;
          });
        }
        return res;
      },
    };

    const bobClient = new RealtimeClient({
      apiOrigin: backend.baseUrl,
      accountId: "usr_bob",
      conversationId,
      device: bobDevice,
      tokenProvider: () => tok("usr_bob"),
      historyClient: racingHistoryClient,
      extraHeaders: { origin: ISS },
      transports: ["websocket"],
      backoffOptions: { scheduleMs: [40, 80], jitterRatio: 0 },
    });
    activeClients.push(bobClient);

    const s0 = await bobClient.connect();
    expect(s0.connectionStatus).toBe("connected");
    expect(s0.subscribedConversationId).toBe(conversationId);

    // 1. Live seq 1 and seq 2 arrive normally
    await sendEncryptedText(
      backend.baseUrl,
      "usr_alice",
      aliceDevice,
      "usr_bob",
      bobDevice,
      conversationId,
      "Baseline live 1",
    );
    await sendEncryptedText(
      backend.baseUrl,
      "usr_alice",
      aliceDevice,
      "usr_bob",
      bobDevice,
      conversationId,
      "দ্বিতীয় বার্তা ২ — বাংলা ইউনিকোড 💬",
    );

    const s2 = await waitUntilSnapshot(bobClient, (s) => s.sync.lastAppliedSeq === 2);
    expect(s2.sync.items).toHaveLength(2);

    // 2. Disconnect Bob while Alice commits seq 3 and seq 4
    bobClient.disconnect();
    expect(bobClient.getSnapshot().connectionStatus).toBe("disconnected");

    await sendEncryptedText(
      backend.baseUrl,
      "usr_alice",
      aliceDevice,
      "usr_bob",
      bobDevice,
      conversationId,
      "Offline missed seq 3",
    );
    await sendEncryptedText(
      backend.baseUrl,
      "usr_alice",
      aliceDevice,
      "usr_bob",
      bobDevice,
      conversationId,
      `<script>alert("xss")</script> Offline missed seq 4`,
    );

    // 3. Reconnect and force race: subscribe succeeds -> HTTP catch-up pauses -> live seq 5 arrives -> HTTP returns [3,4]
    interceptNextNonEmptyCatchUp = true;
    const reconnectPromise = bobClient.connect();
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = () => {
        if (releaseCatchUpFetch) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error("Timed out waiting for catch-up gate"));
          return;
        }
        setTimeout(poll, 10);
      };
      poll();
    });

    // Inject live seq 5 BETWEEN subscribe and HTTP catch-up resolution!
    await sendEncryptedText(
      backend.baseUrl,
      "usr_alice",
      aliceDevice,
      "usr_bob",
      bobDevice,
      conversationId,
      "Arrived live seq 5 during subscribe-to-catchup race",
    );
    await waitUntilSnapshot(bobClient, (s) => s.sync.bufferedCount >= 1);

    releaseCatchUpFetch!();
    const finalSnap = await reconnectPromise;
    expect(finalSnap.connectionStatus).toBe("connected");
    expect(finalSnap.sync.lastAppliedSeq).toBe(5);

    const items = bobClient.getSynchronizer().getItems();
    expect(items.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(items.every((item) => item.kind === "decrypted")).toBe(true);
    const plaintexts = items.map((item) => (item.kind === "decrypted" ? item.plaintext : ""));
    expect(plaintexts).toEqual([
      "Baseline live 1",
      "দ্বিতীয় বার্তা ২ — বাংলা ইউনিকোড 💬",
      "Offline missed seq 3",
      `<script>alert("xss")</script> Offline missed seq 4`,
      "Arrived live seq 5 during subscribe-to-catchup race",
    ]);
  });

  it("detects live sequence gaps, drops/reorders live events, and converges cleanly across permanent gaps", async () => {
    let suppressSeq3Live = true;
    const backend = await startBackend({
      shouldPublishLive: (record) => !(suppressSeq3Live && record.seq === 3),
    });

    await seedUser("usr_alice", "sid_alice", "alice_gap", "Alice");
    await seedUser("usr_bob", "sid_bob", "bob_gap", "Bob");
    const aliceDevice = await enrollOlmDevice(backend.baseUrl, "usr_alice", "dev_alice_gap_01");
    const bobDevice = await enrollOlmDevice(backend.baseUrl, "usr_bob", "dev_bob_gap_02");

    const conversationId = (
      await conversationStore.upsertDirect("usr_alice", "usr_bob", currentNow)
    ).conversation.id;

    const bobClient = new RealtimeClient({
      apiOrigin: backend.baseUrl,
      accountId: "usr_bob",
      conversationId,
      device: bobDevice,
      tokenProvider: () => tok("usr_bob"),
      extraHeaders: { origin: ISS },
      transports: ["websocket"],
    });
    activeClients.push(bobClient);
    await bobClient.connect();

    // Seed seq 1 and seq 2 normally
    await sendEncryptedText(
      backend.baseUrl,
      "usr_alice",
      aliceDevice,
      "usr_bob",
      bobDevice,
      conversationId,
      "Seq 1 steady",
    );
    await sendEncryptedText(
      backend.baseUrl,
      "usr_alice",
      aliceDevice,
      "usr_bob",
      bobDevice,
      conversationId,
      "Seq 2 steady",
    );
    await waitUntilSnapshot(bobClient, (s) => s.sync.lastAppliedSeq === 2);

    // Seq 3 is committed durably, but its live message:new is dropped!
    await sendEncryptedText(
      backend.baseUrl,
      "usr_alice",
      aliceDevice,
      "usr_bob",
      bobDevice,
      conversationId,
      "Seq 3 live-dropped but persisted",
    );
    suppressSeq3Live = false;
    await new Promise((r) => setTimeout(r, 80));
    expect(bobClient.getSynchronizer().getLastAppliedSeq()).toBe(2);

    // Reserve seq 4 as a permanent write-abort gap (never inserted)
    const reservedGapSeq = await conversationStore.reserveNextSeq(
      conversationId,
      "usr_alice",
      currentNow,
    );
    expect(reservedGapSeq).toBe(4);

    // Now Alice sends seq 5 (delivered live!) -> Bob receives 5 while at 2 -> gap recovery pulls [3, 5]!
    await sendEncryptedText(
      backend.baseUrl,
      "usr_alice",
      aliceDevice,
      "usr_bob",
      bobDevice,
      conversationId,
      "Seq 5 triggers gap recovery",
    );

    const converged = await waitUntilSnapshot(
      bobClient,
      (s) => s.sync.lastAppliedSeq === 5 && s.sync.gapRecoveries >= 1 && s.sync.items.length === 4,
    );
    expect(converged.sync.items.map((i) => i.seq)).toEqual([1, 2, 3, 5]);
    expect(converged.sync.items.every((i) => i.kind === "decrypted")).toBe(true);
  });

  it("converges strictly from persisted history across a complete backend process restart (DEC-021 §7.4, NFR-SCALE-002)", async () => {
    const server1 = await startBackend();
    const reusedPort = server1.port;

    await seedUser("usr_alice", "sid_alice", "alice_rst", "Alice");
    await seedUser("usr_bob", "sid_bob", "bob_rst", "Bob");
    const aliceDevice = await enrollOlmDevice(server1.baseUrl, "usr_alice", "dev_alice_rst_01");
    const bobDevice = await enrollOlmDevice(server1.baseUrl, "usr_bob", "dev_bob_rst_02");

    const conversationId = (
      await conversationStore.upsertDirect("usr_alice", "usr_bob", currentNow)
    ).conversation.id;

    const bobClient = new RealtimeClient({
      apiOrigin: server1.baseUrl,
      accountId: "usr_bob",
      conversationId,
      device: bobDevice,
      tokenProvider: () => tok("usr_bob"),
      extraHeaders: { origin: ISS },
      transports: ["websocket"],
      backoffOptions: { scheduleMs: [80, 120, 180], jitterRatio: 0 },
    });
    activeClients.push(bobClient);
    await bobClient.connect();

    await sendEncryptedText(
      server1.baseUrl,
      "usr_alice",
      aliceDevice,
      "usr_bob",
      bobDevice,
      conversationId,
      "Before restart 1",
    );
    await sendEncryptedText(
      server1.baseUrl,
      "usr_alice",
      aliceDevice,
      "usr_bob",
      bobDevice,
      conversationId,
      "Before restart 2",
    );
    await waitUntilSnapshot(bobClient, (s) => s.sync.lastAppliedSeq === 2);

    // Terminate backend #1 completely (Socket.IO volatile memory discarded)
    await server1.close();
    await waitUntilSnapshot(bobClient, (s) => s.connectionStatus === "reconnecting");

    // Boot fresh backend #2 on the exact same port sharing only persisted stores
    const server2 = await startBackend({ listenPort: reusedPort });

    // Send offline messages while server #2 is booting/before Bob resubscribes
    await sendEncryptedText(
      server2.baseUrl,
      "usr_alice",
      aliceDevice,
      "usr_bob",
      bobDevice,
      conversationId,
      "Committed during restart window 3",
    );
    await sendEncryptedText(
      server2.baseUrl,
      "usr_alice",
      aliceDevice,
      "usr_bob",
      bobDevice,
      conversationId,
      "Committed during restart window 4",
    );

    // Bob auto-reconnects, resubscribes to server #2, and catches up 3 & 4 via HTTP persistence
    await waitUntilSnapshot(
      bobClient,
      (s) => s.connectionStatus === "connected" && s.sync.lastAppliedSeq === 4,
      10_000,
    );

    // New live message on server #2 delivers cleanly to re-subscribed Bob
    await sendEncryptedText(
      server2.baseUrl,
      "usr_alice",
      aliceDevice,
      "usr_bob",
      bobDevice,
      conversationId,
      "Live after restart 5",
    );
    const postRestart = await waitUntilSnapshot(bobClient, (s) => s.sync.lastAppliedSeq === 5);

    expect(postRestart.sync.items.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]);
    const texts = postRestart.sync.items.map((i) => (i.kind === "decrypted" ? i.plaintext : ""));
    expect(texts).toEqual([
      "Before restart 1",
      "Before restart 2",
      "Committed during restart window 3",
      "Committed during restart window 4",
      "Live after restart 5",
    ]);

    // Verify wire/history items remain strictly ciphertext-only without forbidden fields
    const wirePage = await new HistoryClient({
      apiOrigin: server2.baseUrl,
      getToken: () => tok("usr_bob"),
    }).fetchPage({ conversationId, after: "0", limit: 50 });
    expect(wirePage.items).toHaveLength(5);
    wirePage.items.forEach((row: HistoryMessageItem) => {
      expect(hasOnlyFields(row, PUBLIC_FIELDS.historyItem)).toBe(true);
    });
  }, 15_000);

  it("transitions to reauth_required on revoked session, stops protected actions, and denies unrelated stranger subscriptions (FR-AUTH-007, INT-003–004)", async () => {
    const backend = await startBackend();

    await seedUser("usr_alice", "sid_alice", "alice_sec", "Alice");
    await seedUser("usr_bob", "sid_bob", "bob_sec", "Bob");
    await seedUser("usr_eve", "sid_eve", "eve_sec", "Eve");

    const aliceDevice = await enrollOlmDevice(backend.baseUrl, "usr_alice", "dev_alice_sec_01");
    const bobDevice = await enrollOlmDevice(backend.baseUrl, "usr_bob", "dev_bob_sec_02");
    await enrollOlmDevice(backend.baseUrl, "usr_eve", "dev_eve_sec_03");

    const conversationId = (
      await conversationStore.upsertDirect("usr_alice", "usr_bob", currentNow)
    ).conversation.id;

    // 1. Unrelated outsider Eve is denied conversation:subscribe and stays unsubscribed
    const eveClient = new RealtimeClient({
      apiOrigin: backend.baseUrl,
      accountId: "usr_eve",
      conversationId,
      device: bobDevice,
      tokenProvider: () => tok("usr_eve"),
      extraHeaders: { origin: ISS },
      transports: ["websocket"],
    });
    activeClients.push(eveClient);
    const eveSnap = await eveClient.connect();
    expect(eveSnap.subscribedConversationId).toBeNull();
    expect(eveSnap.lastError?.code).toBe("NOT_FOUND");
    expect(eveSnap.sync.items).toHaveLength(0);

    // 2. Bob connects and receives seq 1
    let handshakeCount = 0;
    const bobClient = new RealtimeClient({
      apiOrigin: backend.baseUrl,
      accountId: "usr_bob",
      conversationId,
      device: bobDevice,
      tokenProvider: () => {
        if (sessions.get("sid_bob")?.revoked) return null;
        handshakeCount += 1;
        return tok("usr_bob");
      },
      extraHeaders: { origin: ISS },
      transports: ["websocket"],
      backoffOptions: { scheduleMs: [40, 80], jitterRatio: 0 },
    });
    activeClients.push(bobClient);
    await bobClient.connect();

    await sendEncryptedText(
      backend.baseUrl,
      "usr_alice",
      aliceDevice,
      "usr_bob",
      bobDevice,
      conversationId,
      "Visible before revocation",
    );
    await waitUntilSnapshot(bobClient, (s) => s.sync.lastAppliedSeq === 1);
    const countBeforeRevoke = handshakeCount;

    // 3. Revoke Bob's session -> disconnectRevokedSessionSockets triggers immediate reauth_required
    sessions.get("sid_bob")!.revoked = true;
    const disconnectedCount = disconnectRevokedSessionSockets(backend.ioServer, "sid_bob");
    expect(disconnectedCount).toBe(1);

    const revokedSnap = await waitUntilSnapshot(
      bobClient,
      (s) => s.connectionStatus === "reauth_required",
    );
    expect(revokedSnap.protectedActionsBlocked).toBe(true);
    expect(revokedSnap.sync.items).toHaveLength(0);

    // Wait past backoff window to confirm no reconnect attempts or token calls happen
    await new Promise((r) => setTimeout(r, 150));
    expect(handshakeCount).toBe(countBeforeRevoke);
    expect(await bobClient.triggerCatchUp()).toBeNull();
    expect(await bobClient.refreshAuthNow()).toBe(false);
    expect((await bobClient.connect()).connectionStatus).toBe("reauth_required");
  });

  it("denies conversation:subscribe and emits session:expired when an already-connected session is revoked server-side (INT-004, FR-AUTH-007)", async () => {
    const backend = await startBackend();

    await seedUser("usr_alice", "sid_alice", "alice_subrev", "Alice");
    await seedUser("usr_bob", "sid_bob", "bob_subrev", "Bob");
    await enrollOlmDevice(backend.baseUrl, "usr_alice", "dev_alice_subrev_01");
    const bobDevice = await enrollOlmDevice(backend.baseUrl, "usr_bob", "dev_bob_subrev_02");

    const conv1 = (await conversationStore.upsertDirect("usr_alice", "usr_bob", currentNow))
      .conversation.id;
    const conv2 = "conv_second_thread";

    const bobClient = new RealtimeClient({
      apiOrigin: backend.baseUrl,
      accountId: "usr_bob",
      conversationId: conv1,
      device: bobDevice,
      tokenProvider: () => tok("usr_bob"),
      extraHeaders: { origin: ISS },
      transports: ["websocket"],
    });
    activeClients.push(bobClient);
    expect((await bobClient.connect()).connectionStatus).toBe("connected");

    // Revoke Bob's session in Mongo/sessionLookup WITHOUT pushing disconnectRevokedSessionSockets
    sessions.get("sid_bob")!.revoked = true;

    // Switching conversations emits conversation:subscribe; server ensureSocketSessionActive denies & expires
    const switchAllowed = await bobClient.switchConversation(conv2);
    expect(switchAllowed).toBe(false);
    const snap = bobClient.getSnapshot();
    expect(snap.connectionStatus).toBe("reauth_required");
    expect(snap.protectedActionsBlocked).toBe(true);
    expect(snap.reauthReason).toBe("SESSION_REVOKED");
  });
});
