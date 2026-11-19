import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ERROR_HTTP_STATUS,
  MESSAGE_ALLOWED_PROTOCOL_VERSION,
  MESSAGE_CLIENT_FORBIDDEN_FIELDS,
  MESSAGE_FORBIDDEN_FIELDS,
  MESSAGE_MAX_PLAINTEXT_CODE_POINTS,
  PUBLIC_FIELDS,
  hasOnlyFields,
  validateMessageAckSummary,
  validateMessageSendRequest,
  validateMessageSendResponse,
} from "@chat/contracts";
import { OlmAccountDevice, type OlmPeerTarget } from "@chat/crypto";
import { MemoryConversationStore } from "../../apps/api/src/conversations/index.js";
import {
  MESSAGE_READ_CONCERN,
  MESSAGE_WRITE_CONCERN,
  MemoryMessageStore,
  MessageRateLimiter,
  MongoMessageStore,
  computeMessagePayloadHash,
  type MongoMessageCollectionLike,
  type MongoMessageDocument,
} from "../../apps/api/src/messages/index.js";
import {
  MessageSendApiError,
  MessageSendClient,
  mapSendErrorToState,
  prepareEncryptedSend,
} from "../../apps/web/src/features/chat/index.js";
import { errorCopyFor } from "../../apps/web/src/i18n/errors.js";

function toBase64UrlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function createMockMongoMessagesCollection(): {
  collection: MongoMessageCollectionLike;
  seenWriteConcerns: unknown[];
  seenReadConcerns: unknown[];
  docsById: Map<string, MongoMessageDocument>;
  simulateNextInsert: (
    mode:
      "OK" | "UNACKNOWLEDGED" | "DUP_11000_MATCH" | "DUP_11000_CONFLICT" | "DUP_E11000_UNREADABLE",
  ) => void;
} {
  const docsById = new Map<string, MongoMessageDocument>();
  const docsByIdem = new Map<string, MongoMessageDocument>();
  const seenWriteConcerns: unknown[] = [];
  const seenReadConcerns: unknown[] = [];
  let nextMode:
    "OK" | "UNACKNOWLEDGED" | "DUP_11000_MATCH" | "DUP_11000_CONFLICT" | "DUP_E11000_UNREADABLE" =
    "OK";

  const cloneDoc = (doc: MongoMessageDocument): MongoMessageDocument => ({
    ...doc,
    committedAt: new Date(doc.committedAt.getTime()),
  });

  const idemStr = (u: string, d: string, c: string) => `${u}\0${d}\0${c}`;

  const collection: MongoMessageCollectionLike = {
    async findOne(filter, options) {
      if (options && "readConcern" in options) {
        seenReadConcerns.push(options.readConcern);
      }
      if (typeof filter._id === "string") {
        const doc = docsById.get(filter._id);
        return doc ? cloneDoc(doc) : null;
      }
      if (
        typeof filter.senderUserId === "string" &&
        typeof filter.senderDeviceId === "string" &&
        typeof filter.clientMessageId === "string"
      ) {
        const doc = docsByIdem.get(
          idemStr(filter.senderUserId, filter.senderDeviceId, filter.clientMessageId),
        );
        return doc ? cloneDoc(doc) : null;
      }
      return null;
    },

    async insertOne(doc, options) {
      if (options && "writeConcern" in options) {
        seenWriteConcerns.push(options.writeConcern);
      }
      const mode = nextMode;
      nextMode = "OK";

      if (mode === "UNACKNOWLEDGED") {
        return { acknowledged: false };
      }
      if (mode === "DUP_11000_MATCH" || mode === "DUP_11000_CONFLICT") {
        const winner: MongoMessageDocument = {
          ...cloneDoc(doc),
          _id: "msg_mongo_winner",
          payloadHash: mode === "DUP_11000_MATCH" ? doc.payloadHash : "0".repeat(64),
        };
        docsById.set(winner._id, winner);
        docsByIdem.set(
          idemStr(winner.senderUserId, winner.senderDeviceId, winner.clientMessageId),
          winner,
        );
        const err = new Error("duplicate") as Error & { code: number };
        err.code = 11000;
        throw err;
      }
      if (mode === "DUP_E11000_UNREADABLE") {
        throw new Error("E11000 duplicate key error collection: chat.messages");
      }

      const key = idemStr(doc.senderUserId, doc.senderDeviceId, doc.clientMessageId);
      if (docsByIdem.has(key)) {
        const err = new Error("duplicate") as Error & { code: number };
        err.code = 11000;
        throw err;
      }
      docsById.set(doc._id, cloneDoc(doc));
      docsByIdem.set(key, cloneDoc(doc));
      return { acknowledged: true };
    },

    find(filter) {
      const convId = typeof filter.conversationId === "string" ? filter.conversationId : null;
      const items = [...docsById.values()].filter((d) =>
        convId ? d.conversationId === convId : true,
      );
      const cursor = {
        sort(spec: Record<string, 1 | -1>) {
          if (spec.seq === 1) items.sort((a, b) => a.seq - b.seq);
          return cursor;
        },
        async toArray() {
          return items.map(cloneDoc);
        },
      };
      return cursor;
    },
  };

  return {
    collection,
    seenWriteConcerns,
    seenReadConcerns,
    docsById,
    simulateNextInsert(mode) {
      nextMode = mode;
    },
  };
}

async function createEnrolledPair() {
  const alice = await OlmAccountDevice.create({ deviceId: "dev_alice_001" });
  const bob = await OlmAccountDevice.create({ deviceId: "dev_bob_0001" });
  const bobBundle = bob.toPublicKeyBundle();
  const aliceTarget: OlmPeerTarget = {
    peerUserId: "user-bob",
    peerDeviceId: bobBundle.deviceId,
    peerIdentityKey: bobBundle.identityKey,
    peerSenderKey: bobBundle.senderKey,
    peerOneTimeOrFallbackKey: bobBundle.oneTimeKeys[0]!.key,
  };
  return { alice, bob, aliceTarget };
}

describe("P2-04 message contracts & UNAVAILABLE copy", () => {
  it("maps UNAVAILABLE -> 403 with non-block-disclosing EN/BN copy", () => {
    expect(ERROR_HTTP_STATUS.UNAVAILABLE).toBe(403);
    const copy = errorCopyFor("UNAVAILABLE");
    expect(copy.code).toBe("UNAVAILABLE");
    expect(JSON.stringify(copy).toLowerCase()).not.toContain("block");
  });

  it("validates real Olm envelope wire payload and rejects plaintext, downgrade, tamper, and bounds violations", async () => {
    const { alice, bob, aliceTarget } = await createEnrolledPair();
    try {
      const enc = await alice.encryptForPeer(aliceTarget, "Hello Bob! হ্যালো বব 🌸");
      expect(enc.ok).toBe(true);
      if (!enc.ok) throw new Error("encrypt failed");

      const validBody = {
        schemaVersion: 1,
        clientMessageId: randomUUID(),
        senderDeviceId: alice.deviceId,
        protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
        encryptedEnvelope: enc.value.encryptedEnvelope,
      };
      const parsed = validateMessageSendRequest(validBody);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.envelope.recipientDeviceId).toBe(bob.deviceId);
        expect(parsed.value.envelope.messageType).toBe(0);
      }

      // Rejects every forbidden client field (plaintext, keys, server seq/hash/senderUserId).
      for (const forbidden of MESSAGE_CLIENT_FORBIDDEN_FIELDS) {
        const res = validateMessageSendRequest({ ...validBody, [forbidden]: "injected" });
        expect(res.ok, forbidden).toBe(false);
        if (!res.ok) expect(res.code).toBe("INVALID_REQUEST");
      }

      // Rejects legacy or downgraded protocolVersion -> 422 UNSUPPORTED_SCHEMA_VERSION.
      for (const badProto of ["olm-v0", "olm-v1", "dev-webcrypto-v0", "plaintext"]) {
        const res = validateMessageSendRequest({ ...validBody, protocolVersion: badProto });
        expect(res).toMatchObject({ ok: false, code: "UNSUPPORTED_SCHEMA_VERSION" });
      }

      // Rejects plaintext smuggled inside base64url inner envelope JSON.
      const fakeInnerWithPlaintext = toBase64UrlJson({
        schemaVersion: 1,
        protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
        senderDeviceId: alice.deviceId,
        recipientDeviceId: bob.deviceId,
        senderIdentityKey: alice.identityKey,
        senderCurve25519Key: alice.senderKey,
        sessionId: "sess_12345678",
        messageIndex: 0,
        messageType: 0,
        ciphertext: Buffer.alloc(32, 7).toString("base64url"),
        plaintext: "leaked",
      });
      expect(
        validateMessageSendRequest({ ...validBody, encryptedEnvelope: fakeInnerWithPlaintext }),
      ).toMatchObject({ ok: false, code: "INVALID_REQUEST" });

      // Rejects > 16 KiB base64url envelopes -> 413 PAYLOAD_TOO_LARGE.
      const oversized = Buffer.alloc(16 * 1024 + 8, 9).toString("base64url");
      expect(
        validateMessageSendRequest({ ...validBody, encryptedEnvelope: oversized }),
      ).toMatchObject({ ok: false, code: "PAYLOAD_TOO_LARGE" });

      // Rejects truncated ciphertext (< 24 bytes) & mismatched senderDeviceId.
      const mismatchedInner = toBase64UrlJson({
        schemaVersion: 1,
        protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
        senderDeviceId: "dev_other_999",
        recipientDeviceId: bob.deviceId,
        senderIdentityKey: alice.identityKey,
        senderCurve25519Key: alice.senderKey,
        sessionId: "sess_12345678",
        messageIndex: 0,
        messageType: 0,
        ciphertext: Buffer.alloc(32, 7).toString("base64url"),
      });
      expect(
        validateMessageSendRequest({ ...validBody, encryptedEnvelope: mismatchedInner }),
      ).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    } finally {
      alice.dispose();
      bob.dispose();
    }
  });

  it("enforces strict PUBLIC_FIELDS on message ack and rejects forbidden fields", () => {
    const ack = {
      messageId: "msg_1",
      conversationId: "conv_1",
      seq: 1,
      senderUserId: "user-alice",
      senderDeviceId: "dev_alice_001",
      clientMessageId: randomUUID(),
      protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      committedAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1 as const,
    };
    expect(hasOnlyFields(ack, PUBLIC_FIELDS.messageAck)).toBe(true);
    expect(validateMessageAckSummary(ack).ok).toBe(true);
    expect(validateMessageSendResponse({ message: ack, idempotent: false }).ok).toBe(true);

    for (const forbidden of MESSAGE_FORBIDDEN_FIELDS) {
      expect(
        validateMessageSendResponse({
          message: { ...ack, [forbidden]: "bad" },
          idempotent: false,
        }),
      ).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    }
    expect(
      validateMessageSendResponse({
        message: { ...ack, payloadHash: "abc" },
        idempotent: false,
      }),
    ).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });
});

describe("P2-04 durable stores & fault injection (TC-CHAT-003)", () => {
  it("computes collision-resistant canonical SHA-256 payloadHash", () => {
    const h1 = computeMessagePayloadHash({
      conversationId: "ab",
      senderUserId: "c",
      senderDeviceId: "dev_alice_001",
      clientMessageId: "123e4567-e89b-42d3-a456-426614174000",
      protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      encryptedEnvelope: "env1",
    });
    const h2 = computeMessagePayloadHash({
      conversationId: "a",
      senderUserId: "bc",
      senderDeviceId: "dev_alice_001",
      clientMessageId: "123e4567-e89b-42d3-a456-426614174000",
      protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      encryptedEnvelope: "env1",
    });
    expect(h1).toHaveLength(64);
    expect(h1).not.toBe(h2);
  });

  it("handles concurrent idempotent commits, hash conflicts, seq-gap failures, and post-commit dropped acks", async () => {
    const convStore = new MemoryConversationStore({ idGenerator: () => "conv_1" });
    await convStore.upsertDirect("user-a", "user-b", new Date("2026-01-01T00:00:00.000Z"));
    await convStore.upsertDirect("user-a", "user-c", new Date("2026-01-01T00:00:00.000Z"));

    const clientId1 = randomUUID();
    const msgStore = new MemoryMessageStore({
      idGenerator: (() => {
        let n = 0;
        return () => `msg_${++n}`;
      })(),
    });

    const parallel = await Promise.all([
      msgStore.submitDurable({
        conversationId: "conv_1",
        senderUserId: "user-a",
        senderDeviceId: "dev_alice_001",
        clientMessageId: clientId1,
        protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
        encryptedEnvelope: "ZW52XzE",
        conversationStore: convStore,
        now: new Date("2026-01-01T00:00:01.000Z"),
      }),
      msgStore.submitDurable({
        conversationId: "conv_1",
        senderUserId: "user-a",
        senderDeviceId: "dev_alice_001",
        clientMessageId: clientId1,
        protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
        encryptedEnvelope: "ZW52XzE",
        conversationStore: convStore,
        now: new Date("2026-01-01T00:00:01.000Z"),
      }),
    ]);

    expect(parallel.every((r) => r.ok)).toBe(true);
    const ids = new Set(parallel.map((r) => (r.ok ? r.record.id : "")));
    expect(ids).toEqual(new Set(["msg_1"]));
    expect(parallel.filter((r) => r.ok && !r.idempotent)).toHaveLength(1);
    expect(parallel.filter((r) => r.ok && r.idempotent)).toHaveLength(1);
    expect((await convStore.getById("conv_1"))?.lastSeq).toBe(1);

    // Same idempotency key reused with different content or conversation -> 409 IDEMPOTENCY_CONFLICT.
    const conflictContent = await msgStore.submitDurable({
      conversationId: "conv_1",
      senderUserId: "user-a",
      senderDeviceId: "dev_alice_001",
      clientMessageId: clientId1,
      protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      encryptedEnvelope: "ZW52XzI",
      conversationStore: convStore,
    });
    expect(conflictContent).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });

    // Fault 1: fail after seq reservation before insert -> permanent gap allowed, never reused.
    let failInsertOnce = true;
    let failAckOnce = false;
    const faultConvStore = new MemoryConversationStore({ idGenerator: () => "conv_fault" });
    await faultConvStore.upsertDirect("user-a", "user-b");
    const faultStore = new MemoryMessageStore({
      afterSeqReserveBeforeInsert: () => {
        if (failInsertOnce) {
          failInsertOnce = false;
          throw new Error("simulated crash before insert");
        }
      },
      afterInsertBeforeAck: () => {
        if (failAckOnce) {
          failAckOnce = false;
          throw new Error("simulated dropped acknowledgment after durable commit");
        }
      },
    });

    const cidGap = randomUUID();
    const preInsertFail = await faultStore.submitDurable({
      conversationId: "conv_fault",
      senderUserId: "user-a",
      senderDeviceId: "dev_alice_001",
      clientMessageId: cidGap,
      protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      encryptedEnvelope: "ZW52X2dhcA",
      conversationStore: faultConvStore,
    });
    expect(preInsertFail).toEqual({ ok: false, code: "TEMPORARILY_UNAVAILABLE" });
    expect((await faultConvStore.getById("conv_fault"))?.lastSeq).toBe(1);
    expect(await faultStore.listByConversation("conv_fault")).toHaveLength(0);

    // Retry succeeds on seq=2 (seq=1 stays a permanent gap); then arm dropped ack on next send!
    const retryGap = await faultStore.submitDurable({
      conversationId: "conv_fault",
      senderUserId: "user-a",
      senderDeviceId: "dev_alice_001",
      clientMessageId: cidGap,
      protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      encryptedEnvelope: "ZW52X2dhcA",
      conversationStore: faultConvStore,
    });
    expect(retryGap.ok).toBe(true);
    if (retryGap.ok) expect(retryGap.record.seq).toBe(2);

    failAckOnce = true;
    const cidAck = randomUUID();
    const ackDropped = await faultStore.submitDurable({
      conversationId: "conv_fault",
      senderUserId: "user-a",
      senderDeviceId: "dev_alice_001",
      clientMessageId: cidAck,
      protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      encryptedEnvelope: "ZW52X2Fjaw",
      conversationStore: faultConvStore,
    });
    expect(ackDropped).toEqual({ ok: false, code: "TEMPORARILY_UNAVAILABLE" });

    // Retry resolves idempotently to the single committed seq=3 record without bumping lastSeq to 4.
    const ackRecovered = await faultStore.submitDurable({
      conversationId: "conv_fault",
      senderUserId: "user-a",
      senderDeviceId: "dev_alice_001",
      clientMessageId: cidAck,
      protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      encryptedEnvelope: "ZW52X2Fjaw",
      conversationStore: faultConvStore,
    });
    expect(ackRecovered.ok).toBe(true);
    if (ackRecovered.ok) {
      expect(ackRecovered.idempotent).toBe(true);
      expect(ackRecovered.record.seq).toBe(3);
    }
    expect((await faultConvStore.getById("conv_fault"))?.lastSeq).toBe(3);
  });

  it("enforces majority+journal write concern, read concern, and duplicate-key read-back on MongoMessageStore", async () => {
    const convStore = new MemoryConversationStore({ idGenerator: () => "conv_m" });
    await convStore.upsertDirect("user-a", "user-b");
    const mock = createMockMongoMessagesCollection();
    const store = new MongoMessageStore(mock.collection, { idGenerator: () => "msg_mongo_1" });

    const cid1 = randomUUID();
    const committed = await store.submitDurable({
      conversationId: "conv_m",
      senderUserId: "user-a",
      senderDeviceId: "dev_alice_001",
      clientMessageId: cid1,
      protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      encryptedEnvelope: "ZW52X21vbmdv",
      conversationStore: convStore,
    });
    expect(committed.ok).toBe(true);
    expect(mock.seenWriteConcerns[0]).toEqual(MESSAGE_WRITE_CONCERN);
    expect(mock.seenReadConcerns[0]).toEqual(MESSAGE_READ_CONCERN);

    // Unacknowledged writeConcern resolves safely to retryable TEMPORARILY_UNAVAILABLE.
    mock.simulateNextInsert("UNACKNOWLEDGED");
    const unack = await store.submitDurable({
      conversationId: "conv_m",
      senderUserId: "user-a",
      senderDeviceId: "dev_alice_001",
      clientMessageId: randomUUID(),
      protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      encryptedEnvelope: "ZW52X3VuYWNr",
      conversationStore: convStore,
    });
    expect(unack).toEqual({ ok: false, code: "TEMPORARILY_UNAVAILABLE" });

    // 11000 duplicate race with matching payloadHash -> idempotent winner read-back.
    mock.simulateNextInsert("DUP_11000_MATCH");
    const raceMatch = await store.submitDurable({
      conversationId: "conv_m",
      senderUserId: "user-a",
      senderDeviceId: "dev_alice_001",
      clientMessageId: randomUUID(),
      protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      encryptedEnvelope: "ZW52X3JhY2Ux",
      conversationStore: convStore,
    });
    expect(raceMatch.ok).toBe(true);
    if (raceMatch.ok) {
      expect(raceMatch.idempotent).toBe(true);
      expect(raceMatch.record.id).toBe("msg_mongo_winner");
    }

    // 11000 duplicate race with mismatched payloadHash -> IDEMPOTENCY_CONFLICT.
    mock.simulateNextInsert("DUP_11000_CONFLICT");
    const raceConflict = await store.submitDurable({
      conversationId: "conv_m",
      senderUserId: "user-a",
      senderDeviceId: "dev_alice_001",
      clientMessageId: randomUUID(),
      protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      encryptedEnvelope: "ZW52X3JhY2Uy",
      conversationStore: convStore,
    });
    expect(raceConflict).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });

    // Duplicate race where read-back cannot find winner -> TEMPORARILY_UNAVAILABLE (DEC-021 §4.4).
    mock.simulateNextInsert("DUP_E11000_UNREADABLE");
    const raceUnreadable = await store.submitDurable({
      conversationId: "conv_m",
      senderUserId: "user-a",
      senderDeviceId: "dev_alice_001",
      clientMessageId: randomUUID(),
      protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      encryptedEnvelope: "ZW52X3JhY2Uz",
      conversationStore: convStore,
    });
    expect(raceUnreadable).toEqual({ ok: false, code: "TEMPORARILY_UNAVAILABLE" });
  });
});

describe("P2-04 MessageRateLimiter (30/min, 300/hour, 1,000/day)", () => {
  it("enforces minute/hour/day limits with Retry-After and time-window recovery", () => {
    const limiter = new MessageRateLimiter({ maxPerMinute: 3, maxPerHour: 5, maxPerDay: 7 });
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");

    for (let i = 0; i < 3; i++) {
      expect(limiter.consume("user-a", new Date(t0 + i * 1000))).toEqual({ allowed: true });
    }
    expect(limiter.consume("user-a", new Date(t0 + 5_000))).toMatchObject({
      allowed: false,
      limitScope: "minute",
      retryAfterSeconds: 55,
    });

    // After 1 minute passes, minute slot refills until hour limit (5/hr) hits.
    expect(limiter.consume("user-a", new Date(t0 + 61_000))).toEqual({ allowed: true });
    expect(limiter.consume("user-a", new Date(t0 + 62_000))).toEqual({ allowed: true });
    expect(limiter.consume("user-a", new Date(t0 + 63_000))).toMatchObject({
      allowed: false,
      limitScope: "hour",
    });

    // After 2 hours passes, hour slot refills until day limit (7/day) hits.
    expect(limiter.consume("user-a", new Date(t0 + 2 * 60 * 60 * 1000))).toEqual({ allowed: true });
    expect(limiter.consume("user-a", new Date(t0 + 2 * 60 * 60 * 1000 + 1000))).toEqual({
      allowed: true,
    });
    expect(limiter.consume("user-a", new Date(t0 + 2 * 60 * 60 * 1000 + 2000))).toMatchObject({
      allowed: false,
      limitScope: "day",
    });

    // After 24h, earliest timestamps expire cleanly.
    expect(limiter.consume("user-a", new Date(t0 + 24 * 60 * 60 * 1000 + 5_000))).toEqual({
      allowed: true,
    });
  });
});

describe("P2-04 Web compose/encrypt/send pipeline & state mappers", () => {
  it("encrypts with vodozemac Olm, never sends plaintext, fails closed on crypto bounds/key-change, and reuses exact prepared payload on retry", async () => {
    const { alice, bob, aliceTarget } = await createEnrolledPair();
    try {
      // Rejects plaintext > 8,000 Unicode code points fail-closed before calling fetch.
      const tooLong = await prepareEncryptedSend({
        conversationId: "conv_1",
        senderDevice: alice,
        peerTarget: aliceTarget,
        plaintext: "a".repeat(MESSAGE_MAX_PLAINTEXT_CODE_POINTS + 1),
      });
      expect(tooLong.ok).toBe(false);
      if (!tooLong.ok) expect(tooLong.failure.code).toBe("PAYLOAD_TOO_LARGE");

      const sentBodies: string[] = [];
      let callCount = 0;
      const client = new MessageSendClient({
        apiOrigin: "https://api.example.test",
        expectedUserId: "user-a",
        expectedDeviceId: alice.deviceId,
        getToken: () => "jwt-token-a",
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          callCount += 1;
          sentBodies.push(String(init?.body ?? ""));
          expect(init?.credentials).toBe("omit");
          expect(init?.headers).toMatchObject({
            authorization: "Bearer jwt-token-a",
            "content-type": "application/json",
          });
          if (callCount === 1) {
            return new Response(
              JSON.stringify({
                ok: false,
                requestId: "req-503",
                error: { code: "TEMPORARILY_UNAVAILABLE", message: "retry", retryable: true },
              }),
              { status: 503, headers: { "content-type": "application/json" } },
            );
          }
          const bodyObj = JSON.parse(String(init?.body ?? "{}")) as { clientMessageId: string };
          return new Response(
            JSON.stringify({
              ok: true,
              requestId: "req-200",
              data: {
                message: {
                  messageId: "msg_1",
                  conversationId: "conv_1",
                  seq: 1,
                  senderUserId: "user-a",
                  senderDeviceId: alice.deviceId,
                  clientMessageId: bodyObj.clientMessageId,
                  protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
                  committedAt: "2026-01-01T00:00:00.000Z",
                  schemaVersion: 1,
                },
                idempotent: true,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as typeof fetch,
      });

      const secretPlaintext = "SECRET_MARKER_সুখী_🌸";
      const firstAttempt = await client.composeEncryptAndSend({
        conversationId: "conv_1",
        senderDevice: alice,
        peerTarget: aliceTarget,
        plaintext: secretPlaintext,
      });
      expect(firstAttempt.ok).toBe(false);
      if (firstAttempt.ok) throw new Error("expected unknown");
      expect(firstAttempt.state.status).toBe("unknown");
      expect(firstAttempt.prepared).toBeDefined();
      expect(sentBodies[0]).not.toContain(secretPlaintext);

      // Retry with the exact same PreparedEncryptedSend reuses clientMessageId and exact envelope.
      const retryAck = await client.sendPrepared(firstAttempt.prepared!);
      expect(retryAck.idempotent).toBe(true);
      expect(retryAck.message.seq).toBe(1);
      expect(sentBodies[1]).toBe(sentBodies[0]);

      // Peer key change blocks sending fail-closed without plaintext fallback!
      const blocked = await client.composeEncryptAndSend({
        conversationId: "conv_1",
        senderDevice: alice,
        peerTarget: {
          ...aliceTarget,
          peerIdentityKey: Buffer.alloc(32, 8).toString("base64url"),
        },
        plaintext: "should block on key change",
      });
      expect(blocked.ok).toBe(false);
      expect(blocked.state.status).toBe("failed");

      // State mapping checks for network/unauthenticated/conflict/unavailable/rate-limit.
      expect(
        mapSendErrorToState("cid-1", new MessageSendApiError(0, "NETWORK_ERROR", true, "unknown")),
      ).toMatchObject({ status: "unknown", code: "NETWORK_ERROR" });
      expect(
        mapSendErrorToState(
          "cid-1",
          new MessageSendApiError(401, "SESSION_REVOKED", false, "unauthenticated"),
        ),
      ).toMatchObject({ status: "unauthenticated", code: "SESSION_REVOKED" });
      expect(
        mapSendErrorToState(
          "cid-1",
          new MessageSendApiError(409, "IDEMPOTENCY_CONFLICT", false, "failed"),
        ),
      ).toMatchObject({ status: "failed", code: "IDEMPOTENCY_CONFLICT" });
      expect(
        mapSendErrorToState(
          "cid-1",
          new MessageSendApiError(429, "RATE_LIMITED", true, "retryable_rejected", "req", 19),
        ),
      ).toMatchObject({ status: "failed", code: "RATE_LIMITED", retryAfterSeconds: 19 });
    } finally {
      alice.dispose();
      bob.dispose();
    }
  });
});
