import { createServer, type Server } from "node:http";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { io as socketIoClient, type Socket } from "socket.io-client";
import {
  PRESENCE_LEASE_TTL_MS,
  PRESENCE_SCHEMA_VERSION,
  PUBLIC_FIELDS,
  SOCKET_NAMESPACE,
  SOCKET_SUBSCRIBE_EVENT,
  TYPING_COALESCE_MS,
  TYPING_EXPIRY_MS,
  hasOnlyFields,
  type Envelope,
  type PresenceUpdateEvent,
  type TypingUpdateEvent,
} from "@chat/contracts";
import { OlmAccountDevice } from "@chat/crypto";

import { createApp } from "../../apps/api/src/app.js";
import { createVerifier, mintTestToken } from "../../apps/api/src/auth/jwt.js";
import { clearSessionCache, type SessionRecord } from "../../apps/api/src/auth/session.js";
import { MemoryBlockStore } from "../../apps/api/src/blocks/store.js";
import { MemoryConversationStore } from "../../apps/api/src/conversations/index.js";
import { MemoryDeviceKeyStore } from "../../apps/api/src/keys/store.js";
import { MemoryMessageStore, MessageRateLimiter } from "../../apps/api/src/messages/index.js";
import { InMemoryPresenceStore } from "../../apps/api/src/presence/index.js";
import { MemoryProfileStore, type ProfileRecord } from "../../apps/api/src/profiles/store.js";
import {
  createPresenceSocketHooks,
  createSocketServer,
  publishPresenceUpdate,
  publishTypingUpdate,
} from "../../apps/api/src/socket/index.js";
import { ConversationsClient, MessageSendClient } from "../../apps/web/src/features/chat/index.js";
import {
  HttpPresenceClient,
  PresenceAndTypingController,
  PresenceApiError,
} from "../../apps/web/src/features/presence/index.js";

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
let presenceStore = new InMemoryPresenceStore();

const rawSockets: Socket[] = [];
const olmDevices: OlmAccountDevice[] = [];
const controllers: PresenceAndTypingController[] = [];

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

function buildLiveBackend() {
  let presenceHooksRef: ReturnType<typeof createPresenceSocketHooks> | null = null;
  let ioRef: ReturnType<typeof createSocketServer> | null = null;

  const app = createApp({
    verifier,
    sessionLookup,
    conversationLookup,
    conversationStore: proxyOf(() => conversationStore),
    messageStore: proxyOf(() => messageStore),
    messageRateLimiter: proxyOf(() => messageRateLimiter),
    deviceKeyStore: proxyOf(() => deviceKeyStore),
    profileStore: profileStoreProxy,
    blockStore: proxyOf(() => blockStore),
    presenceStore: proxyOf(() => presenceStore),
    onPresenceUpdated: async (event, peerUserId) => {
      if (ioRef) {
        await publishPresenceUpdate(ioRef, event, peerUserId, {
          sessionLookup,
          now: () => currentNow,
        });
      }
    },
    onTypingUpdated: async (event, peerUserId) => {
      if (ioRef) {
        await publishTypingUpdate(ioRef, event, peerUserId, {
          sessionLookup,
          now: () => currentNow,
        });
      }
    },
    now: () => currentNow,
  });

  const nextServer = createServer(app);
  const nextIo = createSocketServer(nextServer, {
    verifier,
    sessionLookup,
    authorizer: { conversationLookup },
    allowedOrigins: [ISS],
    onPresenceConnect: async (principal, connectionId) => {
      await presenceHooksRef?.onPresenceConnect(principal, connectionId);
    },
    onPresenceHeartbeat: async (principal, connectionId, opts) => {
      await presenceHooksRef?.onPresenceHeartbeat(principal, connectionId, opts);
    },
    onPresenceDisconnect: async (principal, connectionId) => {
      await presenceHooksRef?.onPresenceDisconnect(principal, connectionId);
    },
    onTyping: async (principal, connectionId, payload) => {
      if (!presenceHooksRef) {
        return { ok: true };
      }
      return presenceHooksRef.onTyping(principal, connectionId, payload);
    },
  });
  ioRef = nextIo;
  presenceHooksRef = createPresenceSocketHooks(nextIo, {
    conversationStore: proxyOf(() => conversationStore),
    presenceStore: proxyOf(() => presenceStore),
    blockStore: proxyOf(() => blockStore),
    sessionLookup,
    now: () => currentNow,
  });

  return { nextServer, nextIo };
}

async function restartBackendSamePort(
  options: { resetVolatile?: boolean } = { resetVolatile: true },
) {
  if (ioServer) {
    await ioServer.close();
    ioServer = null;
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (options.resetVolatile !== false) {
    presenceStore.simulateServerRestart();
  }
  await new Promise((resolve) => setTimeout(resolve, 20));

  const { nextServer, nextIo } = buildLiveBackend();
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

async function connectSocket(userId: string): Promise<{
  socket: Socket;
  presenceEvents: PresenceUpdateEvent[];
  typingEvents: TypingUpdateEvent[];
}> {
  const presenceEvents: PresenceUpdateEvent[] = [];
  const typingEvents: TypingUpdateEvent[] = [];

  const socket = socketIoClient(`${baseUrl}${SOCKET_NAMESPACE}`, {
    transports: ["websocket"],
    auth: { token: tok(userId) },
    extraHeaders: { origin: ISS },
    reconnection: false,
    forceNew: true,
  });
  rawSockets.push(socket);

  socket.on("presence:update", (env: Envelope<PresenceUpdateEvent>) => {
    if (env && env.ok && env.data) {
      presenceEvents.push(env.data);
    }
  });
  socket.on("typing:update", (env: Envelope<TypingUpdateEvent>) => {
    if (env && env.ok && env.data) {
      typingEvents.push(env.data);
    }
  });

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

  // Allow server's onPresenceConnect microtask to flush before returning.
  await new Promise((resolve) => setTimeout(resolve, 25));

  return { socket, presenceEvents, typingEvents };
}

async function emitWithAck<T>(
  socket: Socket,
  event: string,
  payload: unknown,
): Promise<Envelope<T>> {
  return new Promise<Envelope<T>>((resolve) => {
    socket.emit(event, payload, (ack: Envelope<T>) => {
      resolve(ack);
    });
  });
}

async function waitFor<T>(
  predicate: () => T | null | undefined | false,
  timeoutMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = predicate();
    if (val) return val;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Timed out waiting for async presence/typing condition.");
}

async function resetWorld() {
  for (const ctrl of controllers.splice(0)) {
    ctrl.dispose();
  }
  for (const s of rawSockets.splice(0)) {
    s.disconnect();
  }
  for (const d of olmDevices.splice(0)) {
    d.dispose();
  }
  clearSessionCache();
  tokens = new Map();
  sessions = new Map();
  profileMap = new Map();
  currentNow = new Date();
  blockStore = new MemoryBlockStore();
  conversationStore = new MemoryConversationStore();
  deviceKeyStore = new MemoryDeviceKeyStore();
  messageStore = new MemoryMessageStore();
  messageRateLimiter = new MessageRateLimiter();
  presenceStore = new InMemoryPresenceStore();
}

beforeAll(async () => {
  const sample = await mintTestToken({
    sub: "usr_bootstrap",
    sid: "sid_bootstrap",
    emailVerified: true,
    iss: ISS,
    aud: AUD,
  });
  keyPair = sample.keyPair;
  verifier = createVerifier({
    appOrigin: ISS,
    apiOrigin: AUD,
    resolveKey: (async () => keyPair.publicKey as never) as never,
  });

  const { nextServer, nextIo } = buildLiveBackend();
  server = nextServer;
  ioServer = nextIo;

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        boundPort = addr.port;
        baseUrl = `http://127.0.0.1:${boundPort}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await resetWorld();
  if (ioServer) {
    await ioServer.close();
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("P2-12 presence & typing live integration suite (TC-PRES-001, TC-PRES-002)", () => {
  beforeEach(async () => {
    await resetWorld();
  });

  afterEach(async () => {
    for (const ctrl of controllers.splice(0)) {
      ctrl.dispose();
    }
    for (const s of rawSockets.splice(0)) {
      s.disconnect();
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  });

  it("TC-PRES-001: verifies unknown initial/restart state, 60s lease, multi-tab aggregation, default-on user-disableable activity sharing, bilateral block override, and stranger denial", async () => {
    await seedUser("usr_p212_alice", "sid_p212_alice", "alice_p212", "Alice");
    await seedUser("usr_p212_bob", "sid_p212_bob", "bob_p212", "Bob");
    await seedUser("usr_p212_mallory", "sid_p212_mallory", "mallory_p212", "Mallory");

    await enrollOlmDevice("usr_p212_alice", "dev_p212_alice");
    await enrollOlmDevice("usr_p212_bob", "dev_p212_bob");

    const aliceConvs = new ConversationsClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_p212_alice",
      getToken: () => tok("usr_p212_alice"),
    });
    const convRes = await aliceConvs.createOrGet("usr_p212_bob");
    const convId = convRes.conversation.id;

    const aliceClient = new HttpPresenceClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_p212_alice",
      getToken: () => tok("usr_p212_alice"),
    });
    const bobClient = new HttpPresenceClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_p212_bob",
      getToken: () => tok("usr_p212_bob"),
    });
    const malloryClient = new HttpPresenceClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_p212_mallory",
      getToken: () => tok("usr_p212_mallory"),
    });

    // 1. Before Bob connects: unknown status, Cache-Control: no-store, default-on activity sharing, zero lastSeen fields.
    const rawPresenceResp = await fetch(`${baseUrl}/api/v1/conversations/${convId}/presence`, {
      headers: { Authorization: `Bearer ${tok("usr_p212_alice")}` },
    });
    expect(rawPresenceResp.status).toBe(200);
    expect(rawPresenceResp.headers.get("cache-control")).toBe("no-store");
    const rawJson = (await rawPresenceResp.json()) as Envelope<{
      presence: Record<string, unknown>;
    }>;
    expect(rawJson.ok).toBe(true);
    if (rawJson.ok) {
      expect(rawJson.data.presence.status).toBe("unknown");
      expect(rawJson.data.presence.typing).toBe(false);
      expect(hasOnlyFields(rawJson.data.presence, PUBLIC_FIELDS.conversationPresence)).toBe(true);
      expect("lastSeen" in rawJson.data.presence).toBe(false);
    }

    const bobDefaultPrefs = await bobClient.getActivityPreferences();
    expect(bobDefaultPrefs.activitySharingEnabled).toBe(true);

    // 2. Stranger Mallory cannot query conversation presence or emit typing via HTTP or Socket.IO (FR-PRES-004).
    await expect(malloryClient.getConversationPresence(convId)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    const mallorySock = await connectSocket("usr_p212_mallory");
    const mallorySubAck = await emitWithAck(mallorySock.socket, SOCKET_SUBSCRIBE_EVENT, {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      conversationId: convId,
      data: { conversationId: convId, lastAppliedSeq: 0 },
    });
    expect(mallorySubAck.ok).toBe(false);
    if (!mallorySubAck.ok) expect(mallorySubAck.error.code).toBe("NOT_FOUND");
    const malloryTypeAck = await emitWithAck(mallorySock.socket, "typing", {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      conversationId: convId,
      data: { isTyping: true },
    });
    expect(malloryTypeAck.ok).toBe(false);
    if (!malloryTypeAck.ok) expect(malloryTypeAck.error.code).toBe("NOT_FOUND");

    // 3. Multi-tab aggregation (FR-PRES-002): connect Alice + Bob Tab 1 -> online; Tab 2 -> stays online; close Tab 1 -> still online; close Tab 2 -> offline.
    const aliceConn = await connectSocket("usr_p212_alice");
    const bobTab1 = await connectSocket("usr_p212_bob");

    await waitFor(() =>
      aliceConn.presenceEvents.find((e) => e.userId === "usr_p212_bob" && e.status === "online"),
    );
    expect((await aliceClient.getConversationPresence(convId)).presence.status).toBe("online");
    expect(mallorySock.presenceEvents).toEqual([]); // Unrelated user never observes Alice/Bob presence.

    const bobTab2 = await connectSocket("usr_p212_bob");
    expect(presenceStore.getActiveConnectionCount("usr_p212_bob", currentNow)).toBe(2);

    bobTab1.socket.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(presenceStore.getActiveConnectionCount("usr_p212_bob", currentNow)).toBe(1);
    expect((await aliceClient.getConversationPresence(convId)).presence.status).toBe("online");

    bobTab2.socket.disconnect();
    await waitFor(() =>
      aliceConn.presenceEvents.find((e) => e.userId === "usr_p212_bob" && e.status === "offline"),
    );
    expect((await aliceClient.getConversationPresence(convId)).presence.status).toBe("offline");

    // 4. 60-second lease heartbeat ("ping") vs lease expiry (FR-PRES-001).
    const bobTab3 = await connectSocket("usr_p212_bob");
    await waitFor(
      () =>
        aliceConn.presenceEvents.filter((e) => e.userId === "usr_p212_bob" && e.status === "online")
          .length >= 2,
    );
    currentNow = new Date(currentNow.getTime() + 35_000);
    const pingAck = await emitWithAck(bobTab3.socket, "ping", {});
    expect(pingAck.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    currentNow = new Date(currentNow.getTime() + 35_000); // 70s total, but 35s since ping -> still online!
    expect((await aliceClient.getConversationPresence(convId)).presence.status).toBe("online");

    currentNow = new Date(currentNow.getTime() + PRESENCE_LEASE_TTL_MS + 1); // lease expires -> offline
    expect((await aliceClient.getConversationPresence(convId)).presence.status).toBe("offline");

    // 5. Backend restart -> presence reports "unknown" until client reconnects (FR-PRES-001).
    const bobTab4 = await connectSocket("usr_p212_bob");
    expect((await aliceClient.getConversationPresence(convId)).presence.status).toBe("online");
    bobTab3.socket.disconnect();
    bobTab4.socket.disconnect();
    aliceConn.socket.disconnect();
    await restartBackendSamePort({ resetVolatile: true });

    expect((await aliceClient.getConversationPresence(convId)).presence.status).toBe("unknown");

    // 6. Activity sharing toggle (DEC-020 §6.3): disabling masks presence to unknown without affecting message delivery!
    const aliceConnAfter = await connectSocket("usr_p212_alice");
    const bobTab5 = await connectSocket("usr_p212_bob");
    await waitFor(() =>
      aliceConnAfter.presenceEvents.find(
        (e) => e.userId === "usr_p212_bob" && e.status === "online",
      ),
    );

    const updatedPref = await bobClient.setActivityPreferences(false);
    expect(updatedPref.activitySharingEnabled).toBe(false);
    await waitFor(() =>
      aliceConnAfter.presenceEvents.find(
        (e) => e.userId === "usr_p212_bob" && e.status === "unknown",
      ),
    );
    expect((await aliceClient.getConversationPresence(convId)).presence.status).toBe("unknown");

    // Message delivery remains fully functional with activitySharingEnabled: false!
    const aliceDevice = olmDevices.find((d) => d.deviceId === "dev_p212_alice")!;
    const bobDevice = olmDevices.find((d) => d.deviceId === "dev_p212_bob")!;
    const alicePub = aliceDevice.toPublicKeyBundle();
    const bobMsgClient = new MessageSendClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_p212_bob",
      expectedDeviceId: bobDevice.deviceId,
      getToken: () => tok("usr_p212_bob"),
    });
    const sendRes = await bobMsgClient.composeEncryptAndSend({
      conversationId: convId,
      senderDevice: bobDevice,
      peerTarget: {
        peerUserId: "usr_p212_alice",
        peerDeviceId: alicePub.deviceId,
        peerIdentityKey: alicePub.identityKey,
        peerSenderKey: alicePub.senderKey,
        peerOneTimeOrFallbackKey: alicePub.oneTimeKeys[0]?.key ?? alicePub.fallbackKey.key,
      },
      plaintext: "Still delivers with activity sharing off",
    });
    expect(sendRes.ok).toBe(true);
    if (!sendRes.ok || sendRes.state.status !== "sent") throw new Error("Expected sent");
    expect(sendRes.state.response.message.seq).toBe(1);

    // 7. Re-enable activity sharing, then bilateral block (DEC-008) MUST override activity sharing in both directions!
    await bobClient.setActivityPreferences(true);
    expect((await aliceClient.getConversationPresence(convId)).presence.status).toBe("online");
    expect((await bobClient.getConversationPresence(convId)).presence.status).toBe("online");

    const blockRes = await fetch(`${baseUrl}/api/v1/blocks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tok("usr_p212_alice")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ blockedUserId: "usr_p212_bob" }),
    });
    expect(blockRes.status).toBe(200);
    await waitFor(() =>
      bobTab5.presenceEvents.find((e) => e.userId === "usr_p212_alice" && e.status === "unknown"),
    );
    expect((await aliceClient.getConversationPresence(convId)).presence.status).toBe("unknown");
    expect((await bobClient.getConversationPresence(convId)).presence.status).toBe("unknown");

    // Connecting another Bob tab while blocked must NOT emit any live "online" event to Alice.
    const countBeforeBlockedReconnect = aliceConnAfter.presenceEvents.length;
    await connectSocket("usr_p212_bob");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(aliceConnAfter.presenceEvents.length).toBe(countBeforeBlockedReconnect);
    expect(PresenceApiError.name).toBe("PresenceApiError");
  });

  it("TC-PRES-002: verifies 2s coalescing, immediate explicit stop, 5s timeout, disconnect/reconnect clearing without replay, and session-revoked socket block", async () => {
    await seedUser("usr_p212_alice", "sid_p212_alice", "alice_p212", "Alice");
    await seedUser("usr_p212_bob", "sid_p212_bob", "bob_p212", "Bob");

    const aliceConvs = new ConversationsClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_p212_alice",
      getToken: () => tok("usr_p212_alice"),
    });
    const convId = (await aliceConvs.createOrGet("usr_p212_bob")).conversation.id;

    const aliceClient = new HttpPresenceClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_p212_alice",
      getToken: () => tok("usr_p212_alice"),
    });
    const bobClient = new HttpPresenceClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_p212_bob",
      getToken: () => tok("usr_p212_bob"),
    });

    const aliceCtrl = new PresenceAndTypingController({
      conversationId: convId,
      currentUserId: "usr_p212_alice",
      peerUserId: "usr_p212_bob",
      client: aliceClient,
      now: () => currentNow.getTime(),
    });
    controllers.push(aliceCtrl);

    const aliceConn = await connectSocket("usr_p212_alice");
    aliceConn.socket.on("presence:update", (env) => aliceCtrl.applyPresenceUpdateEvent(env));
    aliceConn.socket.on("typing:update", (env) => aliceCtrl.applyTypingUpdateEvent(env));

    const bobConn = await connectSocket("usr_p212_bob");
    await waitFor(() => aliceCtrl.getSnapshot().peerStatus === "online");

    await emitWithAck(bobConn.socket, SOCKET_SUBSCRIBE_EVENT, {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      conversationId: convId,
      data: { conversationId: convId, lastAppliedSeq: 0 },
    });

    // 1. Start typing over Socket.IO ("typing" event).
    const ack1 = await emitWithAck(bobConn.socket, "typing", {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      conversationId: convId,
      data: { isTyping: true },
    });
    expect(ack1.ok).toBe(true);
    await waitFor(() => aliceCtrl.getSnapshot().peerTyping === true);
    expect(aliceConn.typingEvents.filter((e) => e.isTyping)).toHaveLength(1);

    // 2. Rapid duplicate within 2 seconds is coalesced (both Socket.IO and HTTP POST /typing).
    currentNow = new Date(currentNow.getTime() + TYPING_COALESCE_MS - 100);
    const ack2 = await emitWithAck(bobConn.socket, "typing:set", {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      conversationId: convId,
      data: { isTyping: true },
    });
    expect(ack2.ok).toBe(false);
    if (!ack2.ok) expect(ack2.error.code).toBe("RATE_LIMITED");
    const httpCoalesced = await bobClient.sendTypingSignal(convId, true);
    expect(httpCoalesced.typing.coalesced).toBe(true);
    expect(httpCoalesced.typing.accepted).toBe(false);
    expect(aliceConn.typingEvents.filter((e) => e.isTyping)).toHaveLength(1);

    // 3. Explicit stop clears immediately even inside 2-second start cooldown.
    const stopAck = await emitWithAck(bobConn.socket, "typing:set", {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      conversationId: convId,
      data: { isTyping: false },
    });
    expect(stopAck.ok).toBe(true);
    await waitFor(() => aliceCtrl.getSnapshot().peerTyping === false);
    expect((await aliceClient.getConversationPresence(convId)).presence.typing).toBe(false);

    // 4. Advance past 2s cooldown, start typing, then advance past 5s expiry -> clears cleanly.
    currentNow = new Date(currentNow.getTime() + TYPING_COALESCE_MS + 100);
    const ack3 = await emitWithAck(bobConn.socket, "typing", {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      conversationId: convId,
      data: { isTyping: true },
    });
    expect(ack3.ok).toBe(true);
    await waitFor(() => aliceCtrl.getSnapshot().peerTyping === true);

    currentNow = new Date(currentNow.getTime() + TYPING_EXPIRY_MS + 1);
    expect((await aliceClient.getConversationPresence(convId)).presence.typing).toBe(false);

    // 5. Disconnect & reconnect: active typing clears on disconnect and never replays after reconnect.
    currentNow = new Date(currentNow.getTime() + TYPING_COALESCE_MS + 100);
    await emitWithAck(bobConn.socket, "typing", {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      conversationId: convId,
      data: { isTyping: true },
    });
    await waitFor(() => aliceCtrl.getSnapshot().peerTyping === true);

    const typingTrueCountBeforeDisconnect = aliceConn.typingEvents.filter((e) => e.isTyping).length;
    bobConn.socket.disconnect();
    await waitFor(() => aliceCtrl.getSnapshot().peerStatus === "offline");
    expect(aliceCtrl.getSnapshot().peerTyping).toBe(false);

    const bobReconnect = await connectSocket("usr_p212_bob");
    await emitWithAck(bobReconnect.socket, SOCKET_SUBSCRIBE_EVENT, {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      conversationId: convId,
      data: { conversationId: convId, lastAppliedSeq: 0 },
    });
    await waitFor(() => aliceCtrl.getSnapshot().peerStatus === "online");
    expect(aliceCtrl.getSnapshot().peerTyping).toBe(false);
    expect(aliceConn.typingEvents.filter((e) => e.isTyping)).toHaveLength(
      typingTrueCountBeforeDisconnect,
    );

    // 6. Revoked session on open socket refuses typing with SESSION_REVOKED and disconnects (FR-AUTH-007).
    sessions.set("sid_p212_bob", {
      ...sessions.get("sid_p212_bob")!,
      revoked: true,
    });
    currentNow = new Date(currentNow.getTime() + TYPING_COALESCE_MS + 100);
    const revokedAck = await emitWithAck(bobReconnect.socket, "typing", {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      conversationId: convId,
      data: { isTyping: true },
    });
    expect(revokedAck.ok).toBe(false);
    if (!revokedAck.ok) expect(revokedAck.error.code).toBe("SESSION_REVOKED");
    expect(aliceConn.typingEvents.filter((e) => e.isTyping)).toHaveLength(
      typingTrueCountBeforeDisconnect,
    );
  });
});
