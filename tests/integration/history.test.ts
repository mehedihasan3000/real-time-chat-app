import { type Server } from "node:http";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PUBLIC_FIELDS,
  encodeCursor,
  encodeHistoryCursor,
  hasOnlyFields,
  type ErrorCode,
} from "@chat/contracts";
import { OlmAccountDevice } from "@chat/crypto";

import { createApp } from "../../apps/api/src/app.js";
import { createVerifier, mintTestToken } from "../../apps/api/src/auth/jwt.js";
import { clearSessionCache, type SessionRecord } from "../../apps/api/src/auth/session.js";
import { MemoryBlockStore } from "../../apps/api/src/blocks/store.js";
import { MemoryConversationStore } from "../../apps/api/src/conversations/index.js";
import { MemoryDeviceKeyStore } from "../../apps/api/src/keys/store.js";
import { MemoryMessageStore, MessageRateLimiter } from "../../apps/api/src/messages/index.js";
import type { ProfileRecord } from "../../apps/api/src/profiles/store.js";
import {
  ConversationsClient,
  HistoryClient,
  HistoryController,
  MessageSendClient,
  prepareEncryptedSend,
} from "../../apps/web/src/features/chat/index.js";

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
let throwNextHistoryQuery = false;

const olmDevices: OlmAccountDevice[] = [];

function tok(userId: string): string {
  const value = tokens.get(userId);
  if (!value) throw new Error(`Missing token for ${userId}`);
  return value;
}

async function seedUser(
  userId: string,
  sid: string,
  username: string,
  displayName: string,
  emailVerified = true,
) {
  const now = new Date();
  const minted = await mintTestToken({
    sub: userId,
    sid,
    emailVerified,
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
    authenticatedAt: new Date(now.getTime() - 60_000),
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

function makeFaultableMessageStore(): MemoryMessageStore {
  const base = messageStore;
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "queryHistoryPage") {
        return async (...args: Parameters<MemoryMessageStore["queryHistoryPage"]>) => {
          if (throwNextHistoryQuery) {
            throwNextHistoryQuery = false;
            throw new Error("Simulated internal database driver timeout URI mongodb+srv://secret");
          }
          return target.queryHistoryPage(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function sendEncryptedText(
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

beforeAll(async () => {
  const jose = await import("jose");
  const kp = (await jose.generateKeyPair("Ed25519", {
    extractable: true,
  })) as unknown as Awaited<ReturnType<typeof mintTestToken>>["keyPair"];
  keyPair = { ...kp, kid: "test-history-kid" };
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
  throwNextHistoryQuery = false;

  await seedUser("usr_alice", "sid_alice", "alice_h", "Alice");
  await seedUser("usr_bob", "sid_bob", "bob_h", "Bob");
  await seedUser("usr_carol", "sid_carol", "carol_h", "Carol");
  await seedUser("usr_unverified", "sid_unverified", "unver_h", "Unverified", false);

  const verifier = createVerifier({
    appOrigin: ISS,
    apiOrigin: AUD,
    resolveKey: (async () => keyPair.publicKey as never) as never,
  });

  const app = createApp({
    verifier,
    sessionLookup: async (sid) => sessions.get(sid) ?? null,
    conversationStore,
    deviceKeyStore,
    messageStore: makeFaultableMessageStore(),
    messageRateLimiter,
    blockStore,
    profileStore: {
      async getByUserId(userId) {
        return profileMap.get(userId) ?? null;
      },
      async getByUsername(username) {
        return [...profileMap.values()].find((p) => p.username === username) ?? null;
      },
      async claimUsername() {
        throw new Error("unused");
      },
      async updateDisplayName() {
        throw new Error("unused");
      },
    },
  });

  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Expected ephemeral port.");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  while (olmDevices.length > 0) {
    olmDevices.pop()?.dispose();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

afterAll(() => {
  clearSessionCache();
});

describe("P2-07 — History API pagination, concurrent sends & end-to-end Olm decrypt (TC-HIST-001, FR-CHAT-012, FR-HIST-002, INT-006)", () => {
  it("paginates newest-first before pages without gaps or duplicates during concurrent sends and decrypts all messages in ascending seq order", async () => {
    const aliceDev = await enrollOlmDevice("usr_alice", "dev_alice_hist_int");
    const bobDev = await enrollOlmDevice("usr_bob", "dev_bob_hist_int");

    const convClient = new ConversationsClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_alice",
      getToken: () => tok("usr_alice"),
    });
    const conv = (await convClient.createOrGet("usr_bob")).conversation;

    const plaintexts = [
      "Message 1",
      "দ্বিতীয় বার্তা — ক্ষ জ্ঞ 🇧🇩",
      "Message 3",
      "Message 4",
      `<script>alert("inert")</script>`,
      "Message 6",
      "Message 7",
    ];
    for (const text of plaintexts) {
      await sendEncryptedText("usr_alice", aliceDev, "usr_bob", bobDev, conv.id, text);
    }

    // Verify raw HTTP response headers and zero plaintext/payloadHash disclosure (DATA-003)
    const rawPage1Res = await fetch(`${baseUrl}/api/v1/conversations/${conv.id}/messages?limit=3`, {
      headers: { Authorization: `Bearer ${tok("usr_bob")}` },
    });
    expect(rawPage1Res.status).toBe(200);
    expect(rawPage1Res.headers.get("cache-control")).toBe("no-store");
    const rawPage1Json = (await rawPage1Res.json()) as {
      ok: true;
      data: { items: Array<Record<string, unknown>>; nextCursor: string | null; hasMore: boolean };
    };
    const serializedRaw = JSON.stringify(rawPage1Json);
    expect(serializedRaw).not.toContain("payloadHash");
    expect(serializedRaw).not.toContain("Message 7");
    expect(serializedRaw).not.toContain("<script>");
    expect(hasOnlyFields(rawPage1Json.data, PUBLIC_FIELDS.history)).toBe(true);
    expect(rawPage1Json.data.items.map((i) => i.seq)).toEqual([5, 6, 7]);
    expect(rawPage1Json.data.hasMore).toBe(true);

    // Bob loads initial page via HistoryController
    const historyClient = new HistoryClient({
      apiOrigin: baseUrl,
      getToken: () => tok("usr_bob"),
    });
    const controller = new HistoryController({
      accountId: "usr_bob",
      conversationId: conv.id,
      device: bobDev,
      client: historyClient,
      pageLimit: 3,
    });

    const st1 = await controller.loadInitial();
    expect(st1.status).toBe("ready");
    if (st1.status === "ready") {
      expect(st1.items.map((i) => i.seq)).toEqual([5, 6, 7]);
      expect(st1.hasMore).toBe(true);
    }

    // Concurrent sends happen BEFORE Bob requests page 2 (`before` cursor must NOT be displaced)
    const concurrent8 = await sendEncryptedText(
      "usr_alice",
      aliceDev,
      "usr_bob",
      bobDev,
      conv.id,
      "Concurrent 8",
    );
    const concurrent9 = await sendEncryptedText(
      "usr_alice",
      aliceDev,
      "usr_bob",
      bobDev,
      conv.id,
      "Concurrent 9",
    );
    expect(concurrent8.message.seq).toBe(8);
    expect(concurrent9.message.seq).toBe(9);

    const st2 = await controller.loadOlder();
    expect(st2.status).toBe("ready");
    if (st2.status === "ready") {
      expect(st2.items.map((i) => i.seq)).toEqual([2, 3, 4, 5, 6, 7]);
      expect(st2.hasMore).toBe(true);
    }

    const st3 = await controller.loadOlder();
    expect(st3.status).toBe("ready");
    if (st3.status === "ready") {
      expect(st3.items.map((i) => [i.seq, i.kind])).toEqual([
        [1, "decrypted"],
        [2, "decrypted"],
        [3, "decrypted"],
        [4, "decrypted"],
        [5, "decrypted"],
        [6, "decrypted"],
        [7, "decrypted"],
      ]);
      expect(st3.hasMore).toBe(false);
      expect(st3.nextCursor).toBeNull();
      expect(st3.items.map((i) => (i.kind === "decrypted" ? i.plaintext : null))).toEqual(
        plaintexts,
      );
    }

    // Catch-up via ?after=7 returns [8, 9] with diagnostic latestSeq=9 without duplicates
    const catchUpPage1 = await historyClient.fetchPage({
      conversationId: conv.id,
      after: "0",
      limit: 5,
    });
    expect(catchUpPage1.items.map((i) => i.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(catchUpPage1.hasMore).toBe(true);
    expect(catchUpPage1.latestSeq).toBe(9);

    const catchUpPage2 = await historyClient.fetchPage({
      conversationId: conv.id,
      after: catchUpPage1.nextCursor!,
      limit: 5,
    });
    expect(catchUpPage2.items.map((i) => i.seq)).toEqual([6, 7, 8, 9]);
    expect(catchUpPage2.hasMore).toBe(false);
    expect(catchUpPage2.nextCursor).toBeNull();
    expect(catchUpPage2.latestSeq).toBe(9);
  });

  it("handles permanent seq gaps on aborted writes cleanly during before and after pagination", async () => {
    const aliceDev = await enrollOlmDevice("usr_alice", "dev_alice_gap");
    const bobDev = await enrollOlmDevice("usr_bob", "dev_bob_gap");
    const convClient = new ConversationsClient({
      apiOrigin: baseUrl,
      expectedUserId: "usr_alice",
      getToken: () => tok("usr_alice"),
    });
    const conv = (await convClient.createOrGet("usr_bob")).conversation;

    await sendEncryptedText("usr_alice", aliceDev, "usr_bob", bobDev, conv.id, "First");
    // Reserve seq 2 directly to simulate a crashed/aborted insert after reservation (DEC-021 §4.3)
    const gapSeq = await conversationStore.reserveNextSeq(conv.id, "usr_alice");
    expect(gapSeq).toBe(2);
    await sendEncryptedText("usr_alice", aliceDev, "usr_bob", bobDev, conv.id, "Third");

    const client = new HistoryClient({ apiOrigin: baseUrl, getToken: () => tok("usr_bob") });
    const beforePage = await client.fetchPage({ conversationId: conv.id, limit: 10 });
    expect(beforePage.items.map((i) => i.seq)).toEqual([1, 3]);
    expect(beforePage.hasMore).toBe(false);

    const afterPage = await client.fetchPage({ conversationId: conv.id, after: "0", limit: 10 });
    expect(afterPage.items.map((i) => i.seq)).toEqual([1, 3]);
    expect(afterPage.latestSeq).toBe(3);
  });
});

describe("P2-07 — cursor scope, query bounds, authorization & safe errors (INT-006, DEC-008, ERR-001)", () => {
  it("rejects foreign-conversation, unscoped, and tampered cursors with 400 INVALID_CURSOR and limit > 100 with 400 INVALID_REQUEST", async () => {
    const convAliceBob = await conversationStore.upsertDirect("usr_alice", "usr_bob");
    const convAliceCarol = await conversationStore.upsertDirect("usr_alice", "usr_carol");

    const foreignCursor = encodeHistoryCursor(convAliceCarol.conversation.id, 1);
    const foreignRes = await fetch(
      `${baseUrl}/api/v1/conversations/${convAliceBob.conversation.id}/messages?before=${encodeURIComponent(foreignCursor)}`,
      { headers: { Authorization: `Bearer ${tok("usr_alice")}` } },
    );
    expect(foreignRes.status).toBe(400);
    expect(((await foreignRes.json()) as { error: { code: ErrorCode } }).error.code).toBe(
      "INVALID_CURSOR",
    );

    const unscopedRes = await fetch(
      `${baseUrl}/api/v1/conversations/${convAliceBob.conversation.id}/messages?before=${encodeURIComponent(encodeCursor(1))}`,
      { headers: { Authorization: `Bearer ${tok("usr_alice")}` } },
    );
    expect(unscopedRes.status).toBe(400);
    expect(((await unscopedRes.json()) as { error: { code: ErrorCode } }).error.code).toBe(
      "INVALID_CURSOR",
    );

    for (const badQuery of [
      "limit=101",
      "limit=0",
      "offset=1",
      `before=${encodeURIComponent(encodeHistoryCursor(convAliceBob.conversation.id, 2))}&after=1`,
    ]) {
      const res = await fetch(
        `${baseUrl}/api/v1/conversations/${convAliceBob.conversation.id}/messages?${badQuery}`,
        { headers: { Authorization: `Bearer ${tok("usr_alice")}` } },
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: ErrorCode } }).error.code).toBe(
        "INVALID_REQUEST",
      );
    }
  });

  it("enforces auth, uniform 404 for nonparticipants, keeps history readable when blocked (DEC-008), and returns safe 503 on store failure", async () => {
    const aliceDev = await enrollOlmDevice("usr_alice", "dev_alice_pair");
    const bobDev = await enrollOlmDevice("usr_bob", "dev_bob_pair");
    const conv = (await conversationStore.upsertDirect("usr_alice", "usr_bob")).conversation;

    await sendEncryptedText("usr_alice", aliceDev, "usr_bob", bobDev, conv.id, "Pre-block msg");

    // Unauthenticated -> 401
    const unauth = await fetch(`${baseUrl}/api/v1/conversations/${conv.id}/messages`);
    expect(unauth.status).toBe(401);

    // Revoked session -> 401
    const revokedSid = "sid_revoked_hist";
    sessions.set(revokedSid, {
      sid: revokedSid,
      userId: "usr_bob",
      revoked: true,
      authenticatedAt: new Date(),
    });
    const mintedRevoked = await mintTestToken({
      sub: "usr_bob",
      sid: revokedSid,
      emailVerified: true,
      iss: ISS,
      aud: AUD,
      keyPair,
    });
    const revokedRes = await fetch(`${baseUrl}/api/v1/conversations/${conv.id}/messages`, {
      headers: { Authorization: `Bearer ${mintedRevoked.token}` },
    });
    expect(revokedRes.status).toBe(401);

    // Unverified -> 403
    const unverifiedRes = await fetch(`${baseUrl}/api/v1/conversations/${conv.id}/messages`, {
      headers: { Authorization: `Bearer ${tok("usr_unverified")}` },
    });
    expect(unverifiedRes.status).toBe(403);

    // Stranger gets uniform 404 NOT_FOUND identical to nonexistent conversation
    const strangerRes = await fetch(`${baseUrl}/api/v1/conversations/${conv.id}/messages`, {
      headers: { Authorization: `Bearer ${tok("usr_carol")}` },
    });
    expect(strangerRes.status).toBe(404);
    expect(((await strangerRes.json()) as { error: { code: ErrorCode } }).error.code).toBe(
      "NOT_FOUND",
    );

    // Bilateral block: sends fail, existing history stays readable for both participants without disclosing block
    await blockStore.create("usr_alice", "usr_bob");
    await expect(
      sendEncryptedText("usr_bob", bobDev, "usr_alice", aliceDev, conv.id, "Post-block msg"),
    ).rejects.toMatchObject({ status: 403, code: "UNAVAILABLE" });
    const bobHistWhileBlocked = await fetch(`${baseUrl}/api/v1/conversations/${conv.id}/messages`, {
      headers: { Authorization: `Bearer ${tok("usr_bob")}` },
    });
    expect(bobHistWhileBlocked.status).toBe(200);
    const bobHistJson = (await bobHistWhileBlocked.json()) as {
      ok: true;
      data: { items: Array<Record<string, unknown>> };
    };
    expect(bobHistJson.data.items).toHaveLength(1);
    expect(hasOnlyFields(bobHistJson.data.items[0], PUBLIC_FIELDS.historyItem)).toBe(true);
    expect(JSON.stringify(bobHistJson)).not.toContain("block");

    // Store failure -> safe 503 with zero DB/connection string leakage
    throwNextHistoryQuery = true;
    const errRes = await fetch(`${baseUrl}/api/v1/conversations/${conv.id}/messages`, {
      headers: { Authorization: `Bearer ${tok("usr_alice")}` },
    });
    expect(errRes.status).toBe(503);
    const errText = await errRes.text();
    expect(errText).toContain("TEMPORARILY_UNAVAILABLE");
    expect(errText).not.toContain("mongodb+srv");
    expect(errText).not.toContain("secret");
  });
});
