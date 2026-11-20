import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_READ_RECEIPTS_ENABLED,
  MESSAGE_ALLOWED_PROTOCOL_VERSION,
  MESSAGE_SCHEMA_VERSION,
  PUBLIC_FIELDS,
  READ_RECEIPT_FOCUS_DEBOUNCE_MS,
  RECEIPT_FORBIDDEN_FIELDS,
  RECEIPT_SCHEMA_VERSION,
  computeUnreadCount,
  hasOnlyFields,
  mergeMonotonicReadThroughSeq,
  mergeMonotonicReceiptStage,
  mergeMonotonicTimestamp,
  validateConversationReceiptListResponse,
  validateMessageReceiptDetailResponse,
  validateMessageReceiptEvent,
  validateReadProgressResponse,
  validateReceiptPreferencesView,
  validateSubmitMessageReceiptRequest,
  validateUpdateReadProgressRequest,
  validateUpdateReceiptPreferencesRequest,
} from "@chat/contracts";

import { MemoryConversationStore } from "../../apps/api/src/conversations/index.js";
import { MemoryDeviceKeyStore } from "../../apps/api/src/keys/store.js";
import { MemoryMessageStore, type MessageRecord } from "../../apps/api/src/messages/index.js";
import {
  MemoryReceiptStore,
  MongoReceiptStore,
  calculateConversationUnreadCount,
  submitMessageReceipt,
  type MongoCollectionLike,
  type MongoReadProgressDocument,
  type MongoReceiptDocument,
  type MongoReceiptPreferencesDocument,
} from "../../apps/api/src/receipts/index.js";
import {
  ReceiptsAndUnreadController,
  parseMessageReceiptEventEnvelope,
} from "../../apps/web/src/features/chat/receipts.js";
import type { ReceivedTimelineMessage } from "../../apps/web/src/features/chat/receive.js";

function makeDecryptedItem(
  seq: number,
  senderUserId = "usr_alice_01",
  conversationId = "conv_01",
): ReceivedTimelineMessage {
  return {
    kind: "decrypted",
    messageId: `msg_seq_${seq}`,
    conversationId,
    seq,
    senderUserId,
    senderDeviceId: "dev_sender_01",
    committedAt: `2026-11-20T10:00:0${seq % 10}.000Z`,
    protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
    plaintext: `Message ${seq}`,
    sessionId: "sess_unit_01",
    messageIndex: seq - 1,
    canEmitDeliveryReceipt: true,
    canEmitReadReceipt: true,
  };
}

function makeFailedItem(
  seq: number,
  senderUserId = "usr_alice_01",
  conversationId = "conv_01",
): ReceivedTimelineMessage {
  return {
    kind: "decryption_failed",
    messageId: `msg_seq_${seq}`,
    conversationId,
    seq,
    senderUserId,
    senderDeviceId: "dev_sender_01",
    committedAt: `2026-11-20T10:00:0${seq % 10}.000Z`,
    protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
    failureState: "missing-key",
    code: "MISSING_KEY_MATERIAL",
    recoverable: true,
    canEmitDeliveryReceipt: false,
    canEmitReadReceipt: false,
  };
}

function makeInMemoryMongoCollection<TDoc extends { _id: string }>(
  uniqueCheck?: (docs: TDoc[], candidate: TDoc) => boolean,
): MongoCollectionLike<TDoc> {
  const docs: TDoc[] = [];

  const matches = (doc: TDoc, filter: Record<string, unknown>): boolean => {
    for (const [k, v] of Object.entries(filter)) {
      if (k === "$or" && Array.isArray(v)) {
        if (!v.some((clause) => matches(doc, clause as Record<string, unknown>))) {
          return false;
        }
        continue;
      }
      const val = (doc as Record<string, unknown>)[k];
      if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
        const op = v as Record<string, unknown>;
        if ("$in" in op && Array.isArray(op.$in)) {
          if (!op.$in.includes(val)) return false;
          continue;
        }
      }
      if (val !== v) return false;
    }
    return true;
  };

  return {
    async findOne(filter) {
      return docs.find((d) => matches(d, filter)) ?? null;
    },
    async insertOne(doc) {
      if (uniqueCheck && uniqueCheck(docs, doc)) {
        const dup = new Error("E11000 duplicate key error") as Error & { code: number };
        dup.code = 11000;
        throw dup;
      }
      docs.push(doc);
      return { acknowledged: true };
    },
    async updateOne(filter, update, options) {
      const idx = docs.findIndex((d) => matches(d, filter));
      if (idx === -1) {
        if (options?.upsert) {
          const onInsert = (update.$setOnInsert ?? {}) as Record<string, unknown>;
          const setFields = (update.$set ?? {}) as Record<string, unknown>;
          const created = { ...onInsert, ...setFields } as TDoc;
          docs.push(created);
          return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
        }
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      }
      const target = docs[idx] as Record<string, unknown>;
      if (update.$set && typeof update.$set === "object") {
        Object.assign(target, update.$set);
      }
      if (update.$max && typeof update.$max === "object") {
        for (const [field, maxVal] of Object.entries(update.$max as Record<string, number>)) {
          const cur = Number(target[field] ?? 0);
          if (maxVal > cur) target[field] = maxVal;
        }
      }
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    },
    find(filter) {
      const filtered = docs.filter((d) => matches(d, filter));
      let sortSpec: Record<string, 1 | -1> | null = null;
      return {
        sort(spec) {
          sortSpec = spec;
          return this;
        },
        async toArray() {
          const out = [...filtered];
          if (sortSpec) {
            out.sort((a, b) => {
              for (const [field, dir] of Object.entries(sortSpec!)) {
                const av = (a as Record<string, unknown>)[field];
                const bv = (b as Record<string, unknown>)[field];
                if (av !== bv) {
                  return av! < bv! ? -1 * dir : 1 * dir;
                }
              }
              return 0;
            });
          }
          return out;
        },
      };
    },
    async deleteMany(filter) {
      let deletedCount = 0;
      for (let i = docs.length - 1; i >= 0; i -= 1) {
        if (matches(docs[i]!, filter)) {
          docs.splice(i, 1);
          deletedCount += 1;
        }
      }
      return { deletedCount };
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("P2-11 receipts & unread contracts and validators", () => {
  it("enforces schema constants and strictly rejects client-spoofed, operator, and forbidden fields", () => {
    expect(DEFAULT_READ_RECEIPTS_ENABLED).toBe(false);
    expect(READ_RECEIPT_FOCUS_DEBOUNCE_MS).toBe(500);

    expect(
      validateSubmitMessageReceiptRequest({
        schemaVersion: RECEIPT_SCHEMA_VERSION,
        type: "delivered",
        deviceId: "dev_bob_01",
      }).ok,
    ).toBe(true);

    const spoofs: unknown[] = [
      { schemaVersion: 1, type: "delivered", deviceId: "dev_bob_01", recipientUserId: "usr_bob" },
      { schemaVersion: 1, type: "read", deviceId: "dev_bob_01", senderUserId: "usr_alice" },
      {
        schemaVersion: 1,
        type: "read",
        deviceId: "dev_bob_01",
        deliveredAt: "2026-11-20T00:00:00Z",
      },
      { schemaVersion: 1, type: "sent", deviceId: "dev_bob_01" },
      { schemaVersion: 2, type: "delivered", deviceId: "dev_bob_01" },
      { schemaVersion: 1, type: "delivered", deviceId: "bad" },
      { schemaVersion: 1, type: "delivered", deviceId: "dev_bob_01", $set: { stage: "read" } },
    ];
    for (const payload of spoofs) {
      expect(validateSubmitMessageReceiptRequest(payload).ok).toBe(false);
    }

    for (const key of RECEIPT_FORBIDDEN_FIELDS) {
      expect(
        validateSubmitMessageReceiptRequest({
          schemaVersion: 1,
          type: "delivered",
          deviceId: "dev_bob_01",
          [key]: "leaked",
        }).ok,
      ).toBe(false);
    }

    expect(
      validateUpdateReceiptPreferencesRequest({
        schemaVersion: 1,
        readReceiptsEnabled: true,
        userId: "usr_spoof",
      }).ok,
    ).toBe(false);
    expect(
      validateUpdateReceiptPreferencesRequest({
        schemaVersion: 1,
        readReceiptsEnabled: "true",
      }).ok,
    ).toBe(false);
    expect(
      validateUpdateReadProgressRequest({
        schemaVersion: 1,
        readThroughSeq: 4,
        unreadCount: 0,
      }).ok,
    ).toBe(false);
    expect(
      validateUpdateReadProgressRequest({
        schemaVersion: 1,
        readThroughSeq: -1,
      }).ok,
    ).toBe(false);
  });

  it("matches PUBLIC_FIELDS allowlists across response & socket event validators", () => {
    const view = {
      schemaVersion: 1 as const,
      messageId: "msg_1",
      conversationId: "conv_1",
      seq: 2,
      recipientUserId: "usr_bob",
      recipientDeviceId: "dev_bob_01",
      stage: "read" as const,
      deliveredAt: "2026-11-20T10:00:00.000Z",
      readAt: "2026-11-20T10:00:05.000Z",
      updatedAt: "2026-11-20T10:00:05.000Z",
    };
    const event = { ...view, senderUserId: "usr_alice" };
    const progress = {
      schemaVersion: 1 as const,
      conversationId: "conv_1",
      userId: "usr_bob",
      readThroughSeq: 2,
      latestSeq: 5,
      unreadCount: 3,
      updatedAt: "2026-11-20T10:00:05.000Z",
    };
    const prefs = {
      schemaVersion: 1 as const,
      userId: "usr_bob",
      readReceiptsEnabled: false,
      updatedAt: "2026-11-20T10:00:00.000Z",
    };

    expect(hasOnlyFields(view, PUBLIC_FIELDS.messageReceipt)).toBe(true);
    expect(hasOnlyFields(event, PUBLIC_FIELDS.messageReceiptEvent)).toBe(true);
    expect(hasOnlyFields(progress, PUBLIC_FIELDS.readProgress)).toBe(true);
    expect(hasOnlyFields(prefs, PUBLIC_FIELDS.receiptPreferences)).toBe(true);

    expect(validateMessageReceiptDetailResponse({ receipt: view }).ok).toBe(true);
    expect(validateConversationReceiptListResponse({ items: [view], latestSeq: 5 }).ok).toBe(true);
    expect(validateMessageReceiptEvent(event).ok).toBe(true);
    expect(validateReadProgressResponse({ progress }).ok).toBe(true);
    expect(validateReceiptPreferencesView(prefs).ok).toBe(true);
  });
});

describe("P2-11 monotonic merges, unread math & store persistence", () => {
  it("never regresses stage, timestamps, or readThroughSeq on duplicate/reordered merges", () => {
    expect(mergeMonotonicReceiptStage("sent", "delivered")).toBe("delivered");
    expect(mergeMonotonicReceiptStage("delivered", "read")).toBe("read");
    expect(mergeMonotonicReceiptStage("read", "delivered")).toBe("read");
    expect(mergeMonotonicReceiptStage("read", "sent")).toBe("read");

    expect(mergeMonotonicTimestamp("2026-11-20T01:00:00.000Z", "2026-11-20T02:00:00.000Z")).toBe(
      "2026-11-20T01:00:00.000Z",
    );
    expect(mergeMonotonicTimestamp(null, "2026-11-20T02:00:00.000Z")).toBe(
      "2026-11-20T02:00:00.000Z",
    );

    expect(mergeMonotonicReadThroughSeq(4, 2, 10)).toBe(4);
    expect(mergeMonotonicReadThroughSeq(4, 99, 7)).toBe(7);
    expect(computeUnreadCount(10, 4)).toBe(6);
    expect(computeUnreadCount(3, 5)).toBe(0);
  });

  it("handles gaps and viewer's own messages without inflating unreadCount", () => {
    const baseMsgs: MessageRecord[] = [
      {
        id: "m1",
        conversationId: "conv_1",
        seq: 1,
        senderUserId: "usr_alice",
        senderDeviceId: "dev_alice",
        clientMessageId: "c1",
        payloadHash: "h1",
        protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
        encryptedEnvelope: "e1",
        committedAt: "2026-11-20T00:00:01.000Z",
        schemaVersion: MESSAGE_SCHEMA_VERSION,
      },
      // seq 2 is a permanent gap (e.g. sender deleted)
      {
        id: "m3",
        conversationId: "conv_1",
        seq: 3,
        senderUserId: "usr_bob",
        senderDeviceId: "dev_bob",
        clientMessageId: "c3",
        payloadHash: "h3",
        protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
        encryptedEnvelope: "e3",
        committedAt: "2026-11-20T00:00:03.000Z",
        schemaVersion: MESSAGE_SCHEMA_VERSION,
      },
      {
        id: "m4",
        conversationId: "conv_1",
        seq: 4,
        senderUserId: "usr_alice",
        senderDeviceId: "dev_alice",
        clientMessageId: "c4",
        payloadHash: "h4",
        protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
        encryptedEnvelope: "e4",
        committedAt: "2026-11-20T00:00:04.000Z",
        schemaVersion: MESSAGE_SCHEMA_VERSION,
      },
    ];

    // Bob read through seq 1: seq 2 is gap (0), seq 3 is Bob's own (0), seq 4 is Alice (1)
    expect(calculateConversationUnreadCount(baseMsgs, "usr_bob", 1, 4)).toBe(1);
    // At seq 0, only m1 and m4 are peer unread => 2 (not 4!)
    expect(calculateConversationUnreadCount(baseMsgs, "usr_bob", 0, 4)).toBe(2);
    // Deleting the newest tail message leaves readThroughSeq=4 -> 0 even if conv.lastSeq=5
    expect(calculateConversationUnreadCount(baseMsgs, "usr_bob", 4, 5)).toBe(0);
  });

  it("enforces monotonic upsert, E11000 recovery, and DEC-015 deletion in Memory & Mongo stores", async () => {
    const receiptsCol = makeInMemoryMongoCollection<MongoReceiptDocument>((docs, cand) =>
      docs.some(
        (d) => d.messageId === cand.messageId && d.recipientUserId === cand.recipientUserId,
      ),
    );
    const progressCol = makeInMemoryMongoCollection<MongoReadProgressDocument>((docs, cand) =>
      docs.some((d) => d.conversationId === cand.conversationId && d.userId === cand.userId),
    );
    const prefsCol = makeInMemoryMongoCollection<MongoReceiptPreferencesDocument>((docs, cand) =>
      docs.some((d) => d.userId === cand.userId),
    );

    const mongoStore = new MongoReceiptStore({
      receipts: receiptsCol,
      readProgress: progressCol,
      preferences: prefsCol,
    });
    const memStore = new MemoryReceiptStore();

    for (const store of [memStore, mongoStore]) {
      const t1 = new Date("2026-11-20T08:00:00.000Z");
      const t2 = new Date("2026-11-20T08:01:00.000Z");
      const t3 = new Date("2026-11-20T08:02:00.000Z");

      const d1 = await store.upsertReceipt({
        messageId: "msg_1",
        conversationId: "conv_1",
        seq: 1,
        senderUserId: "usr_alice",
        recipientUserId: "usr_bob",
        recipientDeviceId: "dev_bob_01",
        type: "delivered",
        now: t1,
      });
      expect(d1.advanced).toBe(true);
      expect(d1.record.stage).toBe("delivered");
      expect(d1.record.deliveredAt).toBe(t1.toISOString());

      const r1 = await store.upsertReceipt({
        messageId: "msg_1",
        conversationId: "conv_1",
        seq: 1,
        senderUserId: "usr_alice",
        recipientUserId: "usr_bob",
        recipientDeviceId: "dev_bob_01",
        type: "read",
        now: t2,
      });
      expect(r1.advanced).toBe(true);
      expect(r1.record.stage).toBe("read");
      expect(r1.record.readAt).toBe(t2.toISOString());

      // Stale delivered after read must not regress stage or overwrite deliveredAt/readAt
      const stale = await store.upsertReceipt({
        messageId: "msg_1",
        conversationId: "conv_1",
        seq: 1,
        senderUserId: "usr_alice",
        recipientUserId: "usr_bob",
        recipientDeviceId: "dev_bob_01",
        type: "delivered",
        now: t3,
      });
      expect(stale.advanced).toBe(false);
      expect(stale.record.stage).toBe("read");
      expect(stale.record.deliveredAt).toBe(t1.toISOString());
      expect(stale.record.readAt).toBe(t2.toISOString());

      // Read progress monotonic
      const p1 = await store.advanceReadProgress("conv_1", "usr_bob", 3, 5, t1);
      expect(p1.readThroughSeq).toBe(3);
      const p2 = await store.advanceReadProgress("conv_1", "usr_bob", 1, 5, t2);
      expect(p2.readThroughSeq).toBe(3);

      // Preferences default off & updateable
      expect(await store.getPreferences("usr_bob")).toBeNull();
      await store.setPreferences("usr_bob", true, t1);
      expect((await store.getPreferences("usr_bob"))?.readReceiptsEnabled).toBe(true);

      // DEC-015 deletion removes message receipts and user data
      expect(await store.deleteByMessageIds(["msg_1"])).toBe(1);
      expect(await store.getReceipt("msg_1", "usr_bob")).toBeNull();

      await store.upsertReceipt({
        messageId: "msg_2",
        conversationId: "conv_1",
        seq: 2,
        senderUserId: "usr_alice",
        recipientUserId: "usr_bob",
        recipientDeviceId: "dev_bob_01",
        type: "delivered",
        now: t1,
      });
      expect(await store.deleteByUserId("usr_bob")).toBeGreaterThanOrEqual(3);
      expect(await store.getReceipt("msg_2", "usr_bob")).toBeNull();
      expect(await store.getReadProgress("conv_1", "usr_bob")).toBeNull();
      expect(await store.getPreferences("usr_bob")).toBeNull();
    }
  });

  it("blocks recipient reading own sent receipt or forging receipt with mismatched/revoked device", async () => {
    const convStore = new MemoryConversationStore();
    const { conversation } = await convStore.upsertDirect("usr_alice", "usr_bob");
    const deviceKeyStore = new MemoryDeviceKeyStore();
    const messageStore = new MemoryMessageStore();
    const receiptStore = new MemoryReceiptStore();

    await deviceKeyStore.enroll("usr_alice", {
      schemaVersion: 1,
      algorithm: "olm-vodozemac-v1",
      deviceId: "dev_alice_01",
      identityKey: "a".repeat(43),
      senderKey: "b".repeat(43),
      oneTimeKeys: [{ keyId: "otk_alice_01", key: "c".repeat(43) }],
      fallbackKey: { keyId: "fbk_alice_01", key: "d".repeat(43) },
    });
    await deviceKeyStore.enroll("usr_bob", {
      schemaVersion: 1,
      algorithm: "olm-vodozemac-v1",
      deviceId: "dev_bob_01",
      identityKey: "e".repeat(43),
      senderKey: "f".repeat(43),
      oneTimeKeys: [{ keyId: "otk_bob_01", key: "g".repeat(43) }],
      fallbackKey: { keyId: "fbk_bob_01", key: "h".repeat(43) },
    });

    const sent = await messageStore.submitDurable({
      conversationId: conversation.id,
      senderUserId: "usr_alice",
      senderDeviceId: "dev_alice_01",
      clientMessageId: "client_1",
      protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      encryptedEnvelope: JSON.stringify({
        v: MESSAGE_ALLOWED_PROTOCOL_VERSION,
        recipientDeviceId: "dev_bob_01",
        body: "cipher",
      }),
      conversationStore: convStore,
    });
    if (!sent.ok) throw new Error("Expected message commit");

    // Sender cannot forge delivered receipt for own message
    const selfReceipt = await submitMessageReceipt(
      conversation,
      sent.record.id,
      "usr_alice",
      { schemaVersion: 1, type: "delivered", deviceId: "dev_alice_01" },
      { messageStore, receiptStore, deviceKeyStore },
    );
    expect(selfReceipt.ok).toBe(false);
    if (!selfReceipt.ok) expect(selfReceipt.code).toBe("FORBIDDEN");

    // Recipient wrong device fails
    const wrongDev = await submitMessageReceipt(
      conversation,
      sent.record.id,
      "usr_bob",
      { schemaVersion: 1, type: "delivered", deviceId: "dev_bob_other" },
      { messageStore, receiptStore, deviceKeyStore },
    );
    expect(wrongDev.ok).toBe(false);

    // Revoking Bob's device blocks new receipts
    await deviceKeyStore.revoke("usr_bob", "dev_bob_01", "logout");
    const revokedRes = await submitMessageReceipt(
      conversation,
      sent.record.id,
      "usr_bob",
      { schemaVersion: 1, type: "delivered", deviceId: "dev_bob_01" },
      { messageStore, receiptStore, deviceKeyStore },
    );
    expect(revokedRes.ok).toBe(false);
  });
});

describe("P2-11 ReceiptsAndUnreadController (500 ms debounce, opt-in & ERR-003 isolation)", () => {
  it("enforces 500 ms focus debounce, cancels on blur, skips undecryptable items, and advances private unread even with read receipts off", async () => {
    vi.useFakeTimers();
    const emitted: Array<{ type: "delivered" | "read"; id: string }> = [];
    const committedSeqs: number[] = [];

    const controller = new ReceiptsAndUnreadController({
      accountId: "usr_bob_02",
      conversationId: "conv_01",
      focused: false,
      readReceiptsEnabled: false,
      onEmitReceipt: (type, item) => {
        emitted.push({ type, id: item.messageId });
      },
      onCommitReadProgress: (seq) => {
        committedSeqs.push(seq);
      },
    });

    await controller.syncTimeline(
      [
        makeDecryptedItem(1),
        makeDecryptedItem(2),
        makeFailedItem(3),
        makeDecryptedItem(4, "usr_bob_02"),
      ],
      { latestSeq: 4 },
    );

    // Delivery emitted only for decrypted peer messages (1 & 2); never for failed (3) or own (4)
    expect(emitted).toEqual([
      { type: "delivered", id: "msg_seq_1" },
      { type: "delivered", id: "msg_seq_2" },
    ]);
    // Peer messages 1, 2, 3 unread (own seq 4 does not count)
    expect(controller.getSnapshot().unreadCount).toBe(3);

    // Focusing < 500 ms then blurring emits nothing
    controller.setFocused(true);
    expect(controller.getSnapshot().pendingReadTimerActive).toBe(true);
    await vi.advanceTimersByTimeAsync(450);
    controller.setFocused(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(committedSeqs).toEqual([]);
    expect(controller.getSnapshot().readThroughSeq).toBe(0);

    // Focus for full 500 ms with readReceiptsEnabled=false: private unread updates, ZERO "read" receipts emitted
    controller.setFocused(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(committedSeqs).toEqual([3]);
    expect(controller.getSnapshot().readThroughSeq).toBe(3);
    expect(controller.getSnapshot().unreadCount).toBe(0);
    expect(emitted.filter((e) => e.type === "read")).toEqual([]);

    // Opt-in to read sharing and focus on new message 5 + failed 6
    controller.setReadReceiptsEnabled(true);
    await controller.syncTimeline([makeDecryptedItem(5), makeFailedItem(6)], { latestSeq: 6 });
    await vi.advanceTimersByTimeAsync(500);
    expect(controller.getSnapshot().readThroughSeq).toBe(6);
    expect(emitted.filter((e) => e.type === "read").map((e) => e.id)).toEqual([
      "msg_seq_1",
      "msg_seq_2",
      "msg_seq_5",
    ]);

    // Stale socket "delivered" arrival for already-read message cannot regress
    const accepted = controller.applySocketReceiptEvent({
      ok: true,
      data: {
        schemaVersion: 1,
        messageId: "msg_seq_1",
        conversationId: "conv_01",
        seq: 1,
        senderUserId: "usr_bob_02",
        recipientUserId: "usr_peer",
        recipientDeviceId: "dev_peer_01",
        stage: "read",
        deliveredAt: "2026-11-20T10:01:00.000Z",
        readAt: "2026-11-20T10:02:00.000Z",
        updatedAt: "2026-11-20T10:02:00.000Z",
      },
    });
    expect(accepted).toBe(true);
    controller.applySocketReceiptEvent({
      ok: true,
      data: {
        schemaVersion: 1,
        messageId: "msg_seq_1",
        conversationId: "conv_01",
        seq: 1,
        senderUserId: "usr_bob_02",
        recipientUserId: "usr_peer",
        recipientDeviceId: "dev_peer_01",
        stage: "delivered",
        deliveredAt: "2026-11-20T10:09:00.000Z",
        readAt: null,
        updatedAt: "2026-11-20T10:09:00.000Z",
      },
    });
    const finalReceipt = controller.getSnapshot().senderReceipts.get("msg_seq_1");
    expect(finalReceipt?.stage).toBe("read");
    expect(finalReceipt?.deliveredAt).toBe("2026-11-20T10:01:00.000Z");
    expect(finalReceipt?.readAt).toBe("2026-11-20T10:02:00.000Z");

    // Wrong sender socket receipt ignored
    expect(
      parseMessageReceiptEventEnvelope({
        ok: true,
        data: {
          schemaVersion: 1,
          messageId: "msg_x",
          conversationId: "conv_01",
          seq: 1,
          senderUserId: "usr_other",
          recipientUserId: "usr_bob_02",
          recipientDeviceId: "dev_bob_02",
          stage: "delivered",
          deliveredAt: "2026-11-20T10:00:00.000Z",
          readAt: null,
          updatedAt: "2026-11-20T10:00:00.000Z",
        },
      }).ok,
    ).toBe(true);

    // switchContext cancels pending timer and isolates state (ERR-003)
    controller.switchContext({
      accountId: "usr_carol_03",
      conversationId: "conv_02",
      initialLatestSeq: 0,
    });
    expect(controller.getSnapshot().senderReceipts.size).toBe(0);
    expect(controller.getSnapshot().readThroughSeq).toBe(0);
    expect(controller.getSnapshot().accountId).toBe("usr_carol_03");
    controller.dispose();
  });
});
