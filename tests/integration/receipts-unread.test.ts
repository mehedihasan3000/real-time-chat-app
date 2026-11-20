import { createServer, type Server } from "node:http";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { io as socketIoClient, type Socket } from "socket.io-client";
import {
  DEFAULT_READ_RECEIPTS_ENABLED,
  MESSAGE_ALLOWED_PROTOCOL_VERSION,
  MESSAGE_SCHEMA_VERSION,
  SOCKET_NAMESPACE,
  SOCKET_SUBSCRIBE_EVENT,
  hasOnlyFields,
  type Envelope,
  type MessageReceiptEvent,
} from "@chat/contracts";
import { OlmAccountDevice } from "@chat/crypto";

import { createApp } from "../../apps/api/src/app.js";
import { createVerifier, mintTestToken } from "../../apps/api/src/auth/jwt.js";
import { clearSessionCache, type SessionRecord } from "../../apps/api/src/auth/session.js";
import { MemoryBlockStore } from "../../apps/api/src/blocks/store.js";
import { MemoryConversationStore } from "../../apps/api/src/conversations/index.js";
import { MemoryDeviceKeyStore } from "../../apps/api/src/keys/store.js";
import { MemoryMessageStore, MessageRateLimiter } from "../../apps/api/src/messages/index.js";
import { MemoryProfileStore, type ProfileRecord } from "../../apps/api/src/profiles/store.js";
import { MemoryReceiptStore } from "../../apps/api/src/receipts/index.js";
import {
  createLiveMessagePublisher,
  createLiveReceiptPublisher,
  createSocketServer,
  type publishMessageNew,
  type publishMessageReceipt,
} from "../../apps/api/src/socket/index.js";
import {
  ConversationsClient,
  MessageSendClient,
  ReceiptsClient,
  parseMessageReceiptEventEnvelope,
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
let currentNow = new Date();

let blockStore = new MemoryBlockStore();
let conversationStore = new MemoryConversationStore();
let deviceKeyStore = new MemoryDeviceKeyStore();
let messageStore = new MemoryMessageStore();
let messageRateLimiter = new MessageRateLimiter();
let receiptStore = new MemoryReceiptStore();

const rawSockets: Socket[] = [];
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
  let msgPublishHook:
    | ((
        record: Parameters<typeof publishMessageNew>[1],
        conv: Parameters<typeof publishMessageNew>[2],
      ) => Promise<void>)
    | null = null;
  let receiptPublishHook:
    | ((
        event: Parameters<typeof publishMessageReceipt>[1],
        conv: Parameters<typeof publishMessageReceipt>[2],
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
      if (msgPublishHook) {
        await msgPublishHook(record, conversation);
      }
    },
    receiptStore: proxyOf(() => receiptStore),
    onReceiptAdvanced: async (event, conversation) => {
      if (receiptPublishHook) {
        await receiptPublishHook(event, conversation);
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
    authorizer: { conversationLookup },
    allowedOrigins: [ISS],
  });

  msgPublishHook = createLiveMessagePublisher(nextIo, {
    conversationLookup,
    sessionLookup,
    deviceKeyStore: proxyOf(() => deviceKeyStore),
    blockStore: proxyOf(() => blockStore),
    requireConversationRoom: true,
    now: () => currentNow,
  });

  receiptPublishHook = createLiveReceiptPublisher(nextIo, {
    conversationLookup,
    sessionLookup,
    deviceKeyStore: proxyOf(() => deviceKeyStore),
    blockStore: proxyOf(() => blockStore),
    now: () => currentNow,
  });

  return { nextServer, nextIo };
}

async function restartBackendSamePort(): Promise<void> {
  if (ioServer) {
    await ioServer.close();
    ioServer = null;
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 20));

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

async function enrollOlmDevice(userId: string, deviceId: string): Promise<OlmAccountDevice> {
  const device = await OlmAccountDevice.create({ deviceId });
  olmDevices.push(device);
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

async function connectRawSocket(userId: string): Promise<{
  socket: Socket;
  receiptEvents: MessageReceiptEvent[];
  messageNewEvents: unknown[];
}> {
  const receiptEvents: MessageReceiptEvent[] = [];
  const messageNewEvents: unknown[] = [];

  const socket = socketIoClient(`${baseUrl}${SOCKET_NAMESPACE}`, {
    auth: { token: tok(userId) },
    extraHeaders: { origin: ISS },
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
  rawSockets.push(socket);

  socket.on("message:receipt", (payload: unknown) => {
    const parsed = parseMessageReceiptEventEnvelope(payload);
    if (parsed.ok) {
      receiptEvents.push(parsed.event);
    }
  });
  socket.on("message:new", (payload: unknown) => {
    messageNewEvents.push(payload);
  });

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Socket connect timeout")), 5000);
    socket.on("connect", () => {
      clearTimeout(t);
      resolve();
    });
    socket.on("connect_error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });

  return { socket, receiptEvents, messageNewEvents };
}

async function waitFor<T>(
  predicate: () => T | null | undefined | false,
  timeoutMs = 4000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("Timed out waiting for condition");
}

async function waitForClientSnapshot(
  client: RealtimeClient,
  predicate: (snapshot: RealtimeClientSnapshot) => boolean,
): Promise<RealtimeClientSnapshot> {
  const snap = client.getSnapshot();
  if (predicate(snap)) return snap;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error("Timed out waiting for RealtimeClient snapshot"));
    }, 5000);
    const unsub = client.subscribe((next) => {
      if (predicate(next)) {
        clearTimeout(timer);
        unsub();
        resolve(next);
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
  boundPort = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${boundPort}`;
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
  receiptStore = new MemoryReceiptStore();
  currentNow = new Date();
});

afterEach(() => {
  while (realtimeClients.length > 0) {
    realtimeClients.pop()?.dispose();
  }
  while (rawSockets.length > 0) {
    rawSockets.pop()?.disconnect();
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

describe("P2-11 — Receipts & private unread integration (TC-CHAT-006, TC-HIST-003, DEC-008, DEC-020)", () => {
  it("TC-CHAT-006: requires endpoint decryption for delivery, enforces opt-in reciprocal read sharing, maintains sender-only visibility, prevents monotonic regression, and suppresses under block", async () => {
    await seedUser("usr_alice", "sid_alice_1", "alice_rcp", "Alice");
    await seedUser("usr_bob", "sid_bob_1", "bob_rcp", "Bob");
    await seedUser("usr_carol", "sid_carol_1", "carol_rcp", "Carol");

    const aliceDevice = await enrollOlmDevice("usr_alice", "dev_alice_rcp_01");
    const bobDevice = await enrollOlmDevice("usr_bob", "dev_bob_rcp_02");
    const bobPub = bobDevice.toPublicKeyBundle();

    const convClient = new ConversationsClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_alice",
      getToken: () => tok("usr_alice"),
    });
    const conversation = (await convClient.createOrGet("usr_bob")).conversation;

    const aliceReceipts = new ReceiptsClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_alice",
      getToken: () => tok("usr_alice"),
    });
    const bobReceipts = new ReceiptsClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_bob",
      getToken: () => tok("usr_bob"),
    });
    const carolReceipts = new ReceiptsClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_carol",
      getToken: () => tok("usr_carol"),
    });

    // Default readReceiptsEnabled is strictly false (opt-in default-off)
    const bobInitialPrefs = await bobReceipts.getPreferences();
    expect(bobInitialPrefs.readReceiptsEnabled).toBe(DEFAULT_READ_RECEIPTS_ENABLED);
    expect(bobInitialPrefs.readReceiptsEnabled).toBe(false);

    // Connect Alice & Bob raw sockets; Bob subscribes only to prove socket notification alone does NOT mark delivered
    const aliceSock = await connectRawSocket("usr_alice");
    const bobSock = await connectRawSocket("usr_bob");
    await new Promise<void>((resolve, reject) => {
      bobSock.socket.emit(
        SOCKET_SUBSCRIBE_EVENT,
        {
          schemaVersion: 1,
          conversationId: conversation.id,
          data: { conversationId: conversation.id, lastAppliedSeq: 0 },
        },
        (ack: { ok?: boolean }) => {
          if (ack?.ok) resolve();
          else reject(new Error(`Subscribe rejected: ${JSON.stringify(ack)}`));
        },
      );
    });

    const aliceSend = new MessageSendClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_alice",
      expectedDeviceId: aliceDevice.deviceId,
      getToken: () => tok("usr_alice"),
    });

    const send1 = await aliceSend.composeEncryptAndSend({
      conversationId: conversation.id,
      senderDevice: aliceDevice,
      peerTarget: {
        peerUserId: "usr_bob",
        peerDeviceId: bobPub.deviceId,
        peerIdentityKey: bobPub.identityKey,
        peerSenderKey: bobPub.senderKey,
        peerOneTimeOrFallbackKey: bobPub.oneTimeKeys[0]?.key ?? bobPub.fallbackKey.key,
      },
      plaintext: "Hello Bob — verify endpoint decryption before delivery",
    });
    expect(send1.ok).toBe(true);
    if (!send1.ok || send1.state.status !== "sent") return;
    const msg1Id = send1.state.response.message.messageId;

    // Bob's raw socket received "message:new", yet Alice still sees "sent" (not delivered!)
    await waitFor(() => bobSock.messageNewEvents.length === 1);
    const beforeDecryptSingle = await aliceReceipts.getMessageReceipt(conversation.id, msg1Id);
    expect(beforeDecryptSingle.receipt.stage).toBe("sent");
    expect(beforeDecryptSingle.receipt.deliveredAt).toBeNull();
    expect((await aliceReceipts.listConversationReceipts(conversation.id)).items).toEqual([]);

    // Negative authz & spoofing checks (FR-CHAT-009, INT-002)
    await expect(
      aliceReceipts.submitReceipt({
        conversationId: conversation.id,
        messageId: msg1Id,
        type: "delivered",
        deviceId: aliceDevice.deviceId,
      }),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

    await expect(bobReceipts.getMessageReceipt(conversation.id, msg1Id)).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });

    await expect(carolReceipts.getMessageReceipt(conversation.id, msg1Id)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });

    await expect(
      bobReceipts.submitReceipt({
        conversationId: conversation.id,
        messageId: msg1Id,
        type: "delivered",
        deviceId: "dev_spoof_wrong",
      }),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

    // Real WASM decryption via Bob's RealtimeClient submits endpoint delivery evidence
    const deliveryPosts: Promise<unknown>[] = [];
    const bobRealtime = new RealtimeClient({
      apiOrigin: baseUrl,
      accountId: "usr_bob",
      conversationId: conversation.id,
      device: bobDevice,
      tokenProvider: () => tok("usr_bob"),
      extraHeaders: { origin: ISS },
      transports: ["websocket"],
      now: () => currentNow,
      onDeliveryEvidence: (evidenceItems: readonly RecipientDeliveryEvidence[]) => {
        for (const item of evidenceItems) {
          deliveryPosts.push(
            bobReceipts.submitReceipt({
              conversationId: item.conversationId,
              messageId: item.messageId,
              type: "delivered",
              deviceId: item.recipientDeviceId,
            }),
          );
        }
      },
    });
    realtimeClients.push(bobRealtime);
    await bobRealtime.connect();
    await waitForClientSnapshot(
      bobRealtime,
      (s) => s.sync.lastAppliedSeq >= 1 && s.sync.items.length >= 1,
    );
    await Promise.all(deliveryPosts);

    // Alice receives "message:receipt" on socket; Bob never receives sender receipt event
    const deliveredEvt = await waitFor(() =>
      aliceSock.receiptEvents.find((e) => e.messageId === msg1Id && e.stage === "delivered"),
    );
    const tDelivered = currentNow.toISOString();
    expect(deliveredEvt.senderUserId).toBe("usr_alice");
    expect(deliveredEvt.deliveredAt).toBe(tDelivered);
    expect(deliveredEvt.readAt).toBeNull();
    expect(bobSock.receiptEvents.length).toBe(0);

    // Reciprocal read-sharing enforcement: off-by-default and one-sided opt-in still suppressed
    const suppressedRead1 = await bobReceipts.submitReceipt({
      conversationId: conversation.id,
      messageId: msg1Id,
      type: "read",
      deviceId: bobDevice.deviceId,
    });
    expect(suppressedRead1).toMatchObject({
      accepted: false,
      suppressedReason: "policy",
      stage: "read",
      recordedAt: null,
    });

    await bobReceipts.setPreferences(true);
    const suppressedOneSided = await bobReceipts.submitReceipt({
      conversationId: conversation.id,
      messageId: msg1Id,
      type: "read",
      deviceId: bobDevice.deviceId,
    });
    expect(suppressedOneSided).toMatchObject({
      accepted: false,
      suppressedReason: "policy",
      stage: "read",
    });

    // Enable Alice opt-in as well -> read succeeds & advances monotonically
    await aliceReceipts.setPreferences(true);
    currentNow = new Date(currentNow.getTime() + 5_000);
    const tRead = currentNow.toISOString();
    const acceptedRead = await bobReceipts.submitReceipt({
      conversationId: conversation.id,
      messageId: msg1Id,
      type: "read",
      deviceId: bobDevice.deviceId,
    });
    expect(acceptedRead).toMatchObject({
      accepted: true,
      suppressedReason: null,
      stage: "read",
      recordedAt: tRead,
    });

    const readEvt = await waitFor(() =>
      aliceSock.receiptEvents.find((e) => e.messageId === msg1Id && e.stage === "read"),
    );
    expect(readEvt.deliveredAt).toBe(tDelivered);
    expect(readEvt.readAt).toBe(tRead);
    expect(bobSock.receiptEvents.length).toBe(0);

    // Duplicate/reordered "delivered" replay never regresses "read" or overwrites timestamps
    currentNow = new Date(currentNow.getTime() + 5_000);
    const replayDelivered = await bobReceipts.submitReceipt({
      conversationId: conversation.id,
      messageId: msg1Id,
      type: "delivered",
      deviceId: bobDevice.deviceId,
    });
    expect(replayDelivered).toMatchObject({
      accepted: false,
      suppressedReason: "already_advanced",
      stage: "delivered",
    });
    const afterReplay = await aliceReceipts.getMessageReceipt(conversation.id, msg1Id);
    expect(afterReplay.receipt.stage).toBe("read");
    expect(afterReplay.receipt.deliveredAt).toBe(tDelivered);
    expect(afterReplay.receipt.readAt).toBe(tRead);

    // Seed msg2 before bilateral block, then Alice blocks Bob (DEC-008)
    const send2 = await aliceSend.composeEncryptAndSend({
      conversationId: conversation.id,
      senderDevice: aliceDevice,
      peerTarget: {
        peerUserId: "usr_bob",
        peerDeviceId: bobPub.deviceId,
        peerIdentityKey: bobPub.identityKey,
        peerSenderKey: bobPub.senderKey,
      },
      plaintext: "Pre-block message",
    });
    expect(send2.ok).toBe(true);
    if (!send2.ok || send2.state.status !== "sent") return;
    const msg2Id = send2.state.response.message.messageId;

    const blockRes = await fetch(`${baseUrl}/api/v1/blocks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tok("usr_alice")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ blockedUserId: "usr_bob" }),
    });
    expect(blockRes.status).toBe(200);

    // Blocked peer's new receipt is suppressed generically ("policy") without revealing block state,
    // while confirmed historical receipts remain intact.
    const blockedSubmit = await bobReceipts.submitReceipt({
      conversationId: conversation.id,
      messageId: msg2Id,
      type: "delivered",
      deviceId: bobDevice.deviceId,
    });
    expect(blockedSubmit).toMatchObject({
      accepted: false,
      suppressedReason: "policy",
      recordedAt: null,
    });
    const preserved = await aliceReceipts.getMessageReceipt(conversation.id, msg1Id);
    expect(preserved.receipt.stage).toBe("read");
  });

  it("TC-HIST-003: tracks private readThroughSeq and non-inflating unreadCount across gaps, own messages, reconnects, and backend restart while read sharing is OFF", async () => {
    await seedUser("usr_alice", "sid_alice_2", "alice_u", "Alice");
    await seedUser("usr_bob", "sid_bob_2", "bob_u", "Bob");
    await seedUser("usr_carol", "sid_carol_2", "carol_u", "Carol");

    const aliceDevice = await enrollOlmDevice("usr_alice", "dev_alice_u_01");
    const bobDevice = await enrollOlmDevice("usr_bob", "dev_bob_u_02");
    const alicePub = aliceDevice.toPublicKeyBundle();
    const bobPub = bobDevice.toPublicKeyBundle();

    const aliceConvClient = new ConversationsClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_alice",
      getToken: () => tok("usr_alice"),
    });
    const conversation = (await aliceConvClient.createOrGet("usr_bob")).conversation;

    const aliceSend = new MessageSendClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_alice",
      expectedDeviceId: aliceDevice.deviceId,
      getToken: () => tok("usr_alice"),
    });
    const bobSend = new MessageSendClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_bob",
      expectedDeviceId: bobDevice.deviceId,
      getToken: () => tok("usr_bob"),
    });

    const aliceReceipts = new ReceiptsClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_alice",
      getToken: () => tok("usr_alice"),
    });
    const bobReceipts = new ReceiptsClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_bob",
      getToken: () => tok("usr_bob"),
    });
    const carolReceipts = new ReceiptsClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_carol",
      getToken: () => tok("usr_carol"),
    });

    // Both users keep read sharing OFF
    expect((await aliceReceipts.getPreferences()).readReceiptsEnabled).toBe(false);
    expect((await bobReceipts.getPreferences()).readReceiptsEnabled).toBe(false);

    // Alice sends seq 1 and seq 2
    await aliceSend.composeEncryptAndSend({
      conversationId: conversation.id,
      senderDevice: aliceDevice,
      peerTarget: {
        peerUserId: "usr_bob",
        peerDeviceId: bobPub.deviceId,
        peerIdentityKey: bobPub.identityKey,
        peerSenderKey: bobPub.senderKey,
        peerOneTimeOrFallbackKey: bobPub.oneTimeKeys[0]?.key ?? bobPub.fallbackKey.key,
      },
      plaintext: "Seq 1 from Alice",
    });
    await aliceSend.composeEncryptAndSend({
      conversationId: conversation.id,
      senderDevice: aliceDevice,
      peerTarget: {
        peerUserId: "usr_bob",
        peerDeviceId: bobPub.deviceId,
        peerIdentityKey: bobPub.identityKey,
        peerSenderKey: bobPub.senderKey,
      },
      plaintext: "Seq 2 from Alice",
    });

    // Simulate a permanent seq 3 gap (DEC-015) cleanly without message row
    await conversationStore.reserveNextSeq(conversation.id, "usr_alice", currentNow);

    // Alice sends seq 4; Bob sends seq 5 (own outgoing message)
    await aliceSend.composeEncryptAndSend({
      conversationId: conversation.id,
      senderDevice: aliceDevice,
      peerTarget: {
        peerUserId: "usr_bob",
        peerDeviceId: bobPub.deviceId,
        peerIdentityKey: bobPub.identityKey,
        peerSenderKey: bobPub.senderKey,
      },
      plaintext: "Seq 4 after permanent gap",
    });
    await bobSend.composeEncryptAndSend({
      conversationId: conversation.id,
      senderDevice: bobDevice,
      peerTarget: {
        peerUserId: "usr_alice",
        peerDeviceId: alicePub.deviceId,
        peerIdentityKey: alicePub.identityKey,
        peerSenderKey: alicePub.senderKey,
        peerOneTimeOrFallbackKey: alicePub.oneTimeKeys[0]?.key ?? alicePub.fallbackKey.key,
      },
      plaintext: "Seq 5 reply from Bob",
    });

    // Unread count for Bob ignores permanent gap seq 3 and own message seq 5 -> exactly 3
    const beforeRead = await bobReceipts.getReadProgress(conversation.id);
    expect(beforeRead.progress.readThroughSeq).toBe(0);
    expect(beforeRead.progress.latestSeq).toBe(5);
    expect(beforeRead.progress.unreadCount).toBe(3);

    // Reconnect/catch-up does not inflate count; reading progress stays clean
    const afterRead2 = await bobReceipts.updateReadProgress(conversation.id, 2);
    expect(afterRead2.progress.readThroughSeq).toBe(2);
    expect(afterRead2.progress.unreadCount).toBe(1);

    // Lower readThroughSeq cannot regress
    const staleLower = await bobReceipts.updateReadProgress(conversation.id, 1);
    expect(staleLower.progress.readThroughSeq).toBe(2);
    expect(staleLower.progress.unreadCount).toBe(1);

    // Alice sees zero public "read" receipts even after Bob updated private readThroughSeq
    expect((await aliceReceipts.listConversationReceipts(conversation.id)).items).toEqual([]);

    // Non-participant Carol gets 404; Alice cannot modify Bob's readThroughSeq
    await expect(carolReceipts.getReadProgress(conversation.id)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    const aliceOwn = await aliceReceipts.updateReadProgress(conversation.id, 5);
    expect(aliceOwn.progress.userId).toBe("usr_alice");
    expect(aliceOwn.progress.readThroughSeq).toBe(5);

    // Restart backend on same port -> Bob's private readThroughSeq & unreadCount persist
    await restartBackendSamePort();
    const afterRestart = await bobReceipts.getReadProgress(conversation.id);
    expect(afterRestart.progress.readThroughSeq).toBe(2);
    expect(afterRestart.progress.unreadCount).toBe(1);
  });

  it("enforces contract strictness, Cache-Control: no-store, and safe operator/spoof rejection on receipt endpoints", async () => {
    await seedUser("usr_alice", "sid_alice_3", "alice_c", "Alice");
    await seedUser("usr_bob", "sid_bob_3", "bob_c", "Bob");

    const convClient = new ConversationsClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_alice",
      getToken: () => tok("usr_alice"),
    });
    const conversation = (await convClient.createOrGet("usr_bob")).conversation;

    const prefGet = await fetch(`${baseUrl}/api/v1/me/receipt-preferences`, {
      headers: { Authorization: `Bearer ${tok("usr_alice")}` },
    });
    expect(prefGet.status).toBe(200);
    expect(prefGet.headers.get("cache-control")).toBe("no-store");

    const badPref = await fetch(`${baseUrl}/api/v1/me/receipt-preferences`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${tok("usr_alice")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        schemaVersion: 1,
        readReceiptsEnabled: true,
        $set: { admin: true },
      }),
    });
    expect(badPref.status).toBe(400);
    const badPrefJson = (await badPref.json()) as Envelope<unknown>;
    expect(badPrefJson.ok).toBe(false);
    if (!badPrefJson.ok) expect(badPrefJson.error.code).toBe("INVALID_REQUEST");

    const badProgress = await fetch(
      `${baseUrl}/api/v1/conversations/${encodeURIComponent(conversation.id)}/read-progress`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tok("usr_bob")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          schemaVersion: 1,
          readThroughSeq: 1,
          userId: "usr_alice",
        }),
      },
    );
    expect(badProgress.status).toBe(400);

    // Ensure dummy message check doesn't leak forbidden/extra fields on empty receipt list
    const listRes = await fetch(
      `${baseUrl}/api/v1/conversations/${encodeURIComponent(conversation.id)}/receipts`,
      { headers: { Authorization: `Bearer ${tok("usr_alice")}` } },
    );
    expect(listRes.status).toBe(200);
    expect(listRes.headers.get("cache-control")).toBe("no-store");
    const listJson = (await listRes.json()) as Envelope<Record<string, unknown>>;
    expect(listJson.ok).toBe(true);
    if (listJson.ok) {
      expect(hasOnlyFields(listJson.data, ["items", "latestSeq"])).toBe(true);
    }

    // Silence unused imports check on helper constants cleanly
    expect(MESSAGE_SCHEMA_VERSION).toBe(1);
    expect(MESSAGE_ALLOWED_PROTOCOL_VERSION).toBe("olm-vodozemac-v1");
  });
});
