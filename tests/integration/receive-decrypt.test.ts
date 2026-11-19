import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { io as ioClient, type Socket } from "socket.io-client";
import {
  MESSAGE_ALLOWED_PROTOCOL_VERSION,
  MESSAGE_SCHEMA_VERSION,
  PUBLIC_FIELDS,
  hasOnlyFields,
  successEnvelope,
  type MessageNewEvent,
} from "@chat/contracts";
import { OlmAccountDevice, base64UrlDecode, base64UrlEncode } from "@chat/crypto";

import { createApp } from "../../apps/api/src/app.js";
import { createVerifier, mintTestToken } from "../../apps/api/src/auth/jwt.js";
import { clearSessionCache, type SessionRecord } from "../../apps/api/src/auth/session.js";
import { MemoryBlockStore } from "../../apps/api/src/blocks/store.js";
import { MemoryConversationStore } from "../../apps/api/src/conversations/index.js";
import { MemoryDeviceKeyStore } from "../../apps/api/src/keys/store.js";
import { MemoryMessageStore, MessageRateLimiter } from "../../apps/api/src/messages/index.js";
import { MemoryProfileStore, type ProfileRecord } from "../../apps/api/src/profiles/store.js";
import {
  createLiveMessagePublisher,
  createSocketServer,
  type publishMessageNew,
} from "../../apps/api/src/socket/index.js";
import {
  ConversationsClient,
  MessageSendClient,
  ReceiveMessageTimeline,
  prepareEncryptedSend,
} from "../../apps/web/src/features/chat/index.js";

const ISS = "https://app.example.test";
const AUD = "https://api.example.test";

let server: Server;
let ioServer: ReturnType<typeof createSocketServer> | null = null;
let baseUrl = "";
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

const openSockets: Socket[] = [];
const olmDevices: OlmAccountDevice[] = [];

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

async function enrollOlmDevice(userId: string, deviceId: string): Promise<OlmAccountDevice> {
  const device = await OlmAccountDevice.create({ deviceId });
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
  return device;
}

async function connectSocket(userId: string): Promise<Socket> {
  const socket = ioClient(`${baseUrl}/v1`, {
    transports: ["websocket"],
    extraHeaders: { origin: ISS },
    auth: { token: tok(userId) },
    reconnection: false,
  });
  openSockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Socket connect timeout for ${userId}`)), 5000);
    socket.once("connected", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return socket;
}

async function joinConversation(socket: Socket, conversationId: string): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    socket.emit("join", { schemaVersion: 1, conversationId, data: {} }, (ack: { ok: boolean }) => {
      resolve(ack);
    });
  });
}

function waitForEvent<T>(socket: Socket, eventName: string, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${eventName}`)),
      timeoutMs,
    );
    socket.once(eventName, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function mutateEnvelopeCiphertext(encodedEnvelope: string): string {
  const decoded = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(base64UrlDecode(encodedEnvelope)),
  ) as Record<string, unknown>;
  const ct = new Uint8Array(base64UrlDecode(String(decoded.ciphertext)));
  ct[ct.length - 1] = (ct[ct.length - 1] ?? 0) ^ 0xff;
  decoded.ciphertext = base64UrlEncode(ct);
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(decoded)));
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
  const verifier = createVerifier({
    appOrigin: ISS,
    apiOrigin: AUD,
    resolveKey: (async () => keyPair.publicKey as never) as never,
  });

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
      if (publishHook) await publishHook(record, conversation);
    },
    deviceKeyStore: proxyOf(() => deviceKeyStore),
    profileStore: profileStoreProxy,
    blockStore: proxyOf(() => blockStore),
    now: () => currentNow,
  });

  server = createServer(app);
  ioServer = createSocketServer(server, {
    verifier,
    sessionLookup,
    authorizer: {
      conversationLookup,
    },
    allowedOrigins: [ISS],
  });

  publishHook = createLiveMessagePublisher(ioServer, {
    conversationLookup,
    sessionLookup,
    deviceKeyStore: proxyOf(() => deviceKeyStore),
    blockStore: proxyOf(() => blockStore),
    now: () => currentNow,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
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

afterEach(() => {
  while (openSockets.length > 0) {
    openSockets.pop()?.disconnect();
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

describe("P2-06 — Live HTTP->Socket.IO->Olm receive/decrypt/render integration (TC-CHAT-002, TC-CHAT-008)", () => {
  it("delivers ciphertext strictly to authorized connected recipient endpoints, excludes unrelated Eve, and round-trips Bengali/emoji/script-like text intact", async () => {
    await seedUser("usr_alice", "sid_alice", "alice_chat", "Alice");
    await seedUser("usr_bob", "sid_bob", "bob_chat", "Bob");
    await seedUser("usr_eve", "sid_eve", "eve_outsider", "Eve");

    const aliceDevice = await enrollOlmDevice("usr_alice", "dev_alice_live_01");
    const bobDevice = await enrollOlmDevice("usr_bob", "dev_bob_live_02");
    await enrollOlmDevice("usr_eve", "dev_eve_live_03");

    const convClient = new ConversationsClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_alice",
      getToken: () => tok("usr_alice"),
    });
    const created = await convClient.createOrGet("usr_bob");
    const conversationId = created.conversation.id;

    // Connect Bob (authorized recipient) and Eve (unrelated outsider)
    const bobSocket = await connectSocket("usr_bob");
    const eveSocket = await connectSocket("usr_eve");

    // Authorized member can join conversation room; unrelated Eve is denied
    expect((await joinConversation(bobSocket, conversationId)).ok).toBe(true);
    expect((await joinConversation(eveSocket, conversationId)).ok).toBe(false);

    const eveReceived: unknown[] = [];
    eveSocket.on("message:new", (payload) => eveReceived.push(payload));

    const bobTimeline = new ReceiveMessageTimeline({
      accountId: "usr_bob",
      conversationId,
      device: bobDevice,
    });

    const bobBundle = bobDevice.toPublicKeyBundle();
    const sendClient = new MessageSendClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_alice",
      expectedDeviceId: aliceDevice.deviceId,
      getToken: () => tok("usr_alice"),
    });

    const testMessages = [
      "MARKER_BN_UNICODE আমি বাংলায় কথা বলি — ক্ষ, জ্ঞ, র‍্যাপিড 🇧🇩👨‍👩‍👧‍👦💬🔐",
      `MARKER_XSS <script>alert("xss")</script><img src=x onerror="evil()" />`,
    ];

    for (let i = 0; i < testMessages.length; i += 1) {
      const plaintext = testMessages[i]!;
      const livePromise = waitForEvent<{ ok: true; requestId: string; data: MessageNewEvent }>(
        bobSocket,
        "message:new",
      );

      const prepared = await prepareEncryptedSend({
        conversationId,
        senderDevice: aliceDevice,
        peerTarget: {
          peerUserId: "usr_bob",
          peerDeviceId: bobDevice.deviceId,
          peerIdentityKey: bobDevice.identityKey,
          peerSenderKey: bobDevice.senderKey,
          peerOneTimeOrFallbackKey: bobBundle.oneTimeKeys[0]!.key,
        },
        plaintext,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const sent = await sendClient.sendPrepared(prepared.prepared);
      expect(sent.message.seq).toBe(i + 1);

      const rawLive = await livePromise;
      expect(rawLive.ok).toBe(true);
      expect(hasOnlyFields(rawLive.data, PUBLIC_FIELDS.messageNew)).toBe(true);
      // Plaintext markers must NEVER appear in wire payload or server storage
      const wireJson = JSON.stringify(rawLive);
      expect(wireJson).not.toContain("MARKER_BN_UNICODE");
      expect(wireJson).not.toContain("MARKER_XSS");
      expect(wireJson).not.toContain("payloadHash");

      const stored = await messageStore.getById(sent.message.messageId);
      expect(stored).not.toBeNull();
      expect(JSON.stringify(stored)).not.toContain("MARKER_BN_UNICODE");
      expect(JSON.stringify(stored)).not.toContain("MARKER_XSS");

      const ingested = await bobTimeline.ingestSocketMessageNew(rawLive);
      expect(ingested.applied).toBe(true);
    }

    // Allow event loop ticks to prove Eve received zero message:new events
    await new Promise((r) => setTimeout(r, 150));
    expect(eveReceived).toHaveLength(0);

    const rendered = bobTimeline.getItems();
    expect(rendered).toHaveLength(2);
    expect(rendered[0]?.kind).toBe("decrypted");
    expect(rendered[1]?.kind).toBe("decrypted");
    if (rendered[0]?.kind === "decrypted" && rendered[1]?.kind === "decrypted") {
      expect(rendered[0].plaintext).toBe(testMessages[0]);
      expect(rendered[1].plaintext).toBe(testMessages[1]);
      expect(rendered[0].canEmitDeliveryReceipt).toBe(true);
      expect(rendered[1].canEmitReadReceipt).toBe(true);
    }
    bobTimeline.dispose();
  });

  it("blocks live message:new delivery when recipient session or device is revoked and preserves explicit tamper/missing-key placeholders", async () => {
    await seedUser("usr_alice", "sid_alice", "alice_rev", "Alice");
    await seedUser("usr_bob", "sid_bob", "bob_rev", "Bob");

    const aliceDevice = await enrollOlmDevice("usr_alice", "dev_alice_rev_01");
    const bobDevice = await enrollOlmDevice("usr_bob", "dev_bob_rev_02");
    const conv = await conversationStore.upsertDirect("usr_alice", "usr_bob", currentNow);
    const conversationId = conv.conversation.id;

    const bobSocket = await connectSocket("usr_bob");
    const bobEvents: unknown[] = [];
    bobSocket.on("message:new", (payload) => bobEvents.push(payload));

    const bobBundle = bobDevice.toPublicKeyBundle();
    const sendClient = new MessageSendClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_alice",
      expectedDeviceId: aliceDevice.deviceId,
      getToken: () => tok("usr_alice"),
    });

    // 1. Revoke Bob's session (INT-004): Alice sends, server commits, but live socket receives nothing
    const bobSession = sessions.get("sid_bob")!;
    bobSession.revoked = true;

    const prep1 = await prepareEncryptedSend({
      conversationId,
      senderDevice: aliceDevice,
      peerTarget: {
        peerUserId: "usr_bob",
        peerDeviceId: bobDevice.deviceId,
        peerIdentityKey: bobDevice.identityKey,
        peerSenderKey: bobDevice.senderKey,
        peerOneTimeOrFallbackKey: bobBundle.oneTimeKeys[0]!.key,
      },
      plaintext: "Sent while Bob session revoked",
    });
    expect(prep1.ok).toBe(true);
    if (!prep1.ok) return;
    await sendClient.sendPrepared(prep1.prepared);

    await new Promise((r) => setTimeout(r, 120));
    expect(bobEvents).toHaveLength(0);

    // 2. Restore Bob's session, then revoke Bob's device (FR-SEC-010): revoked device gets no live ciphertext
    bobSession.revoked = false;
    await deviceKeyStore.revoke("usr_bob", bobDevice.deviceId, "loss", currentNow);

    const prep2 = await prepareEncryptedSend({
      conversationId,
      senderDevice: aliceDevice,
      peerTarget: {
        peerUserId: "usr_bob",
        peerDeviceId: bobDevice.deviceId,
        peerIdentityKey: bobDevice.identityKey,
        peerSenderKey: bobDevice.senderKey,
      },
      plaintext: "Sent while Bob device revoked",
    });
    expect(prep2.ok).toBe(true);
    if (!prep2.ok) return;
    await sendClient.sendPrepared(prep2.prepared);

    await new Promise((r) => setTimeout(r, 120));
    expect(bobEvents).toHaveLength(0);

    // 3. Tampered / missing-key envelopes on Bob's timeline stay identifiable and non-receipt-eligible
    const timeline = new ReceiveMessageTimeline({
      accountId: "usr_bob",
      conversationId,
      device: bobDevice,
    });
    const tamperedEvent: MessageNewEvent = {
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      messageId: "msg_tampered_live",
      conversationId,
      seq: 99,
      senderUserId: "usr_alice",
      senderDeviceId: aliceDevice.deviceId,
      clientMessageId: randomUUID(),
      protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      encryptedEnvelope: mutateEnvelopeCiphertext(prep1.prepared.payload.encryptedEnvelope),
      committedAt: currentNow.toISOString(),
    };
    const outcome = await timeline.ingestSocketMessageNew(successEnvelope(tamperedEvent));
    expect(outcome.applied).toBe(true);
    const items = timeline.getItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("decryption_failed");
    if (items[0]?.kind === "decryption_failed") {
      expect(items[0].messageId).toBe("msg_tampered_live");
      expect(items[0].seq).toBe(99);
      expect(items[0].failureState).toBe("tampered-envelope");
      expect(items[0].canEmitDeliveryReceipt).toBe(false);
      expect(items[0].canEmitReadReceipt).toBe(false);
    }
    timeline.dispose();
  });
});
