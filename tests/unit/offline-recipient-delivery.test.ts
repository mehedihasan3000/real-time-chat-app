import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import {
  MESSAGE_ALLOWED_PROTOCOL_VERSION,
  MESSAGE_SCHEMA_VERSION,
  decodeHistoryAfterReference,
  type HistoryMessageItem,
  type HistoryPageResponse,
} from "@chat/contracts";
import { OlmAccountDevice, type OlmPeerTarget } from "@chat/crypto";

import { MemoryConversationStore } from "../../apps/api/src/conversations/index.js";
import {
  MESSAGE_RETENTION_AUTO_EXPIRY_MS,
  MemoryMessageStore,
  MongoMessageStore,
  OfflineRecipientDeliveryTracker,
  type MessageRecord,
  type MongoMessageCollectionLike,
  type MongoMessageDocument,
} from "../../apps/api/src/messages/index.js";
import {
  ConversationCatchUpSynchronizer,
  type RecipientDeliveryEvidence,
} from "../../apps/web/src/lib/realtime/index.js";
import type { HistoryPageFetcher } from "../../apps/web/src/features/chat/history.js";

function toHistoryWireItem(record: MessageRecord): HistoryMessageItem {
  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    messageId: record.id,
    conversationId: record.conversationId,
    seq: record.seq,
    senderUserId: record.senderUserId,
    senderDeviceId: record.senderDeviceId,
    clientMessageId: record.clientMessageId,
    protocolVersion: record.protocolVersion,
    encryptedEnvelope: record.encryptedEnvelope,
    committedAt: record.committedAt,
  };
}

function makeOpaqueTestEnvelope(
  recipientDeviceId: string,
  senderDeviceId = "dev_alice_01",
): string {
  const inner = {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
    senderDeviceId,
    recipientDeviceId,
    senderIdentityKey: "a".repeat(43),
    senderCurve25519Key: "b".repeat(43),
    sessionId: "sess_unit_p210_01",
    messageIndex: 0,
    messageType: 0,
    ciphertext: Buffer.from("synthetic-encrypted-bytes-p210", "utf8").toString("base64url"),
  };
  return Buffer.from(JSON.stringify(inner), "utf8").toString("base64url");
}

function createInMemoryMongoMessageCollection(): MongoMessageCollectionLike {
  const docs = new Map<string, MongoMessageDocument>();
  const idem = new Map<string, string>();

  const matchesFilter = (doc: MongoMessageDocument, filter: Record<string, unknown>): boolean => {
    for (const [key, cond] of Object.entries(filter)) {
      const value = (doc as unknown as Record<string, unknown>)[key];
      if (typeof cond === "object" && cond !== null && !Array.isArray(cond)) {
        const ops = cond as Record<string, unknown>;
        if ("$in" in ops && Array.isArray(ops.$in) && !ops.$in.includes(value)) return false;
        if ("$ne" in ops && value === ops.$ne) return false;
        if ("$gt" in ops && !(typeof value === "number" && value > (ops.$gt as number)))
          return false;
        if ("$lt" in ops && !(typeof value === "number" && value < (ops.$lt as number)))
          return false;
      } else if (value !== cond) {
        return false;
      }
    }
    return true;
  };

  return {
    async findOne(filter) {
      if (typeof filter._id === "string") {
        return docs.get(filter._id) ?? null;
      }
      if (
        typeof filter.senderUserId === "string" &&
        typeof filter.senderDeviceId === "string" &&
        typeof filter.clientMessageId === "string"
      ) {
        const id = idem.get(
          `${filter.senderUserId}\0${filter.senderDeviceId}\0${filter.clientMessageId}`,
        );
        return id ? (docs.get(id) ?? null) : null;
      }
      return null;
    },
    async insertOne(doc) {
      const k = `${doc.senderUserId}\0${doc.senderDeviceId}\0${doc.clientMessageId}`;
      if (idem.has(k)) {
        const err = new Error("E11000") as Error & { code: number };
        err.code = 11000;
        throw err;
      }
      docs.set(doc._id, { ...doc, committedAt: new Date(doc.committedAt.getTime()) });
      idem.set(k, doc._id);
      return { acknowledged: true };
    },
    find(filter) {
      const list = [...docs.values()].filter((d) => matchesFilter(d, filter));
      let sorted = [...list];
      const cursor = {
        sort(spec: Record<string, 1 | -1>) {
          const dir = spec.seq ?? 1;
          sorted.sort((a, b) => (a.seq - b.seq) * dir);
          return cursor;
        },
        limit(count: number) {
          sorted = sorted.slice(0, count);
          return cursor;
        },
        async toArray() {
          return sorted.map((d) => ({ ...d, committedAt: new Date(d.committedAt.getTime()) }));
        },
      };
      return cursor;
    },
    async deleteMany(filter) {
      let count = 0;
      for (const [id, doc] of [...docs.entries()]) {
        if (matchesFilter(doc, filter)) {
          docs.delete(id);
          idem.delete(`${doc.senderUserId}\0${doc.senderDeviceId}\0${doc.clientMessageId}`);
          count += 1;
        }
      }
      return { deletedCount: count };
    },
  };
}

describe("P2-10 unit — Offline recipient delivery, retention, revocation purge & recovery (TC-CHAT-004, DEC-015, DEC-020, DEC-021)", () => {
  it("tracks sent -> delivered monotonically only after authorized recipient decryption evidence", () => {
    const tracker = new OfflineRecipientDeliveryTracker();
    const conv = { id: "conv_01", participantIds: ["usr_alice", "usr_bob"] as [string, string] };
    const record: MessageRecord = {
      id: "msg_01",
      conversationId: "conv_01",
      seq: 1,
      senderUserId: "usr_alice",
      senderDeviceId: "dev_alice_01",
      clientMessageId: randomUUID(),
      payloadHash: "h".repeat(64),
      protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      encryptedEnvelope: makeOpaqueTestEnvelope("dev_bob_01", "dev_alice_01"),
      committedAt: "2026-11-20T08:00:00.000Z",
      schemaVersion: 1,
    };

    const initial = tracker.registerCommittedMessage(record, conv);
    expect(initial.stage).toBe("sent");
    expect(initial.recipientUserId).toBe("usr_bob");
    expect(initial.recipientDeviceId).toBe("dev_bob_01");
    expect(initial.deliveredAt).toBeNull();
    expect(tracker.isDelivered(record.id)).toBe(false);

    // Forged sender / outsider / undecrypted / mismatched-device delivery evidence rejected.
    expect(
      tracker.recordDeliveryEvidence({
        messageId: record.id,
        actorUserId: "usr_alice",
        actorDeviceId: "dev_alice_01",
        decrypted: true,
      }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });

    expect(
      tracker.recordDeliveryEvidence({
        messageId: record.id,
        actorUserId: "usr_eve",
        actorDeviceId: "dev_bob_01",
        decrypted: true,
      }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });

    expect(
      tracker.recordDeliveryEvidence({
        messageId: record.id,
        actorUserId: "usr_bob",
        actorDeviceId: "dev_bob_01",
        decrypted: false,
      }),
    ).toMatchObject({ ok: false, code: "DECRYPTION_REQUIRED" });

    expect(
      tracker.recordDeliveryEvidence({
        messageId: record.id,
        actorUserId: "usr_bob",
        actorDeviceId: "dev_bob_wrong",
        decrypted: true,
      }),
    ).toMatchObject({ ok: false, code: "DEVICE_REVOKED" });

    expect(
      tracker.recordDeliveryEvidence({
        messageId: record.id,
        actorUserId: "usr_bob",
        actorDeviceId: "dev_bob_01",
        decrypted: true,
        activeRecipientDeviceId: "dev_bob_02",
      }),
    ).toMatchObject({ ok: false, code: "DEVICE_REVOKED" });

    expect(tracker.isDelivered(record.id)).toBe(false);

    // Authorized recipient decryption advances sent -> delivered idempotently.
    const t1 = new Date("2026-11-20T09:00:00.000Z");
    const delivered = tracker.recordDeliveryEvidence({
      messageId: record.id,
      actorUserId: "usr_bob",
      actorDeviceId: "dev_bob_01",
      decrypted: true,
      activeRecipientDeviceId: "dev_bob_01",
      now: t1,
    });
    expect(delivered).toMatchObject({
      ok: true,
      advanced: true,
      record: { stage: "delivered", deliveredAt: t1.toISOString(), readAt: null },
    });
    expect(tracker.isDelivered(record.id)).toBe(true);

    // Repeated registration or duplicate delivery evidence never regresses or mutates timestamp.
    expect(tracker.registerCommittedMessage(record, conv).stage).toBe("delivered");
    const dupDelivered = tracker.recordDeliveryEvidence({
      messageId: record.id,
      actorUserId: "usr_bob",
      actorDeviceId: "dev_bob_01",
      decrypted: true,
      now: new Date("2026-11-20T10:00:00.000Z"),
    });
    expect(dupDelivered).toMatchObject({
      ok: true,
      advanced: false,
      record: { stage: "delivered", deliveredAt: t1.toISOString() },
    });
  });

  it("enforces opt-in reciprocal focused read rules and sender-only receipt visibility (DEC-020 §7)", () => {
    const tracker = new OfflineRecipientDeliveryTracker();
    const conv = { id: "conv_02", participantIds: ["usr_alice", "usr_bob"] as [string, string] };
    const record: MessageRecord = {
      id: "msg_02",
      conversationId: "conv_02",
      seq: 1,
      senderUserId: "usr_alice",
      senderDeviceId: "dev_alice_01",
      clientMessageId: randomUUID(),
      payloadHash: "h".repeat(64),
      protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      encryptedEnvelope: makeOpaqueTestEnvelope("dev_bob_01"),
      committedAt: "2026-11-20T08:00:00.000Z",
      schemaVersion: 1,
    };
    tracker.registerCommittedMessage(record, conv);

    // Background catch-up (not displayed in focused conversation) must not advance read.
    const bgSync = tracker.recordReadEvidence({
      messageId: record.id,
      actorUserId: "usr_bob",
      actorDeviceId: "dev_bob_01",
      decrypted: true,
      displayedInFocusedConversation: false,
      recipientReadSharingEnabled: true,
      senderReadSharingEnabled: true,
    });
    expect(bgSync).toMatchObject({
      ok: true,
      suppressedRead: true,
      record: { stage: "delivered", readAt: null },
    });

    // Recipient read sharing default off -> stays delivered.
    const defaultOff = tracker.recordReadEvidence({
      messageId: record.id,
      actorUserId: "usr_bob",
      actorDeviceId: "dev_bob_01",
      decrypted: true,
      displayedInFocusedConversation: true,
      recipientReadSharingEnabled: false,
      senderReadSharingEnabled: true,
    });
    expect(defaultOff).toMatchObject({
      ok: true,
      suppressedRead: true,
      record: { stage: "delivered", readAt: null },
    });

    // Reciprocity: sender read sharing off -> recipient cannot advance public read.
    const nonReciprocal = tracker.recordReadEvidence({
      messageId: record.id,
      actorUserId: "usr_bob",
      actorDeviceId: "dev_bob_01",
      decrypted: true,
      displayedInFocusedConversation: true,
      recipientReadSharingEnabled: true,
      senderReadSharingEnabled: false,
    });
    expect(nonReciprocal).toMatchObject({
      ok: true,
      suppressedRead: true,
      record: { stage: "delivered", readAt: null },
    });

    // All gates satisfied -> advances to read; stays monotonic thereafter.
    const tRead = new Date("2026-11-20T12:00:00.000Z");
    const readRes = tracker.recordReadEvidence({
      messageId: record.id,
      actorUserId: "usr_bob",
      actorDeviceId: "dev_bob_01",
      decrypted: true,
      displayedInFocusedConversation: true,
      recipientReadSharingEnabled: true,
      senderReadSharingEnabled: true,
      now: tRead,
    });
    expect(readRes).toMatchObject({
      ok: true,
      advanced: true,
      suppressedRead: false,
      record: { stage: "read", readAt: tRead.toISOString() },
    });

    // Subsequent delivery or suppressed-read event must not regress from read -> delivered.
    const lateDelivery = tracker.recordDeliveryEvidence({
      messageId: record.id,
      actorUserId: "usr_bob",
      actorDeviceId: "dev_bob_01",
      decrypted: true,
    });
    expect(lateDelivery).toMatchObject({ ok: true, advanced: false, record: { stage: "read" } });

    // Sender-only visibility (DEC-020 §7.2).
    expect(tracker.getSenderView(record.id, "usr_alice")?.stage).toBe("read");
    expect(tracker.getSenderView(record.id, "usr_bob")).toBeNull();
    expect(tracker.getSenderView(record.id, "usr_eve")).toBeNull();
    expect(tracker.listSenderConversationView("conv_02", "usr_alice")).toHaveLength(1);
    expect(tracker.listSenderConversationView("conv_02", "usr_bob")).toHaveLength(0);
  });

  it("retains ciphertext without automatic TTL across +365d and isolates account-deletion purge to deleting sender (DEC-015 §3–§4)", async () => {
    expect(MESSAGE_RETENTION_AUTO_EXPIRY_MS).toBeNull();

    const stores = [
      { name: "MemoryMessageStore", store: new MemoryMessageStore() },
      {
        name: "MongoMessageStore",
        store: new MongoMessageStore(createInMemoryMongoMessageCollection()),
      },
    ];

    for (const { store } of stores) {
      const convStore = new MemoryConversationStore();
      const baseTime = new Date("2026-01-01T00:00:00.000Z");
      const convId = (await convStore.upsertDirect("usr_alice", "usr_bob", baseTime)).conversation
        .id;

      await store.submitDurable({
        conversationId: convId,
        senderUserId: "usr_alice",
        senderDeviceId: "dev_alice_01",
        clientMessageId: randomUUID(),
        protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
        encryptedEnvelope: makeOpaqueTestEnvelope("dev_bob_01", "dev_alice_01"),
        conversationStore: convStore,
        now: baseTime,
      });
      await store.submitDurable({
        conversationId: convId,
        senderUserId: "usr_bob",
        senderDeviceId: "dev_bob_01",
        clientMessageId: randomUUID(),
        protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
        encryptedEnvelope: makeOpaqueTestEnvelope("dev_alice_01", "dev_bob_01"),
        conversationStore: convStore,
        now: new Date(baseTime.getTime() + 90 * 86_400_000),
      });

      // Even after +365 days offline, retained messages remain catch-up readable (no auto-TTL).
      const afterYear = await store.queryHistoryPage({
        conversationId: convId,
        limit: 50,
        beforeSeq: null,
        afterSeq: 0,
      });
      expect(afterYear.items).toHaveLength(2);

      // Account deletion for Alice deletes only Alice's sent messages and keeps Bob's own message.
      const deletedCount = await store.deleteBySenderUserId("usr_alice");
      expect(deletedCount).toBe(1);
      const remaining = await store.listByConversation(convId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.senderUserId).toBe("usr_bob");
    }
  });

  it("purges undelivered queued ciphertext for a revoked recipient device while preserving delivered/active items (FR-SEC-010, DEC-004)", async () => {
    const stores = [
      { name: "MemoryMessageStore", store: new MemoryMessageStore() },
      {
        name: "MongoMessageStore",
        store: new MongoMessageStore(createInMemoryMongoMessageCollection()),
      },
    ];

    for (const { store } of stores) {
      const convStore = new MemoryConversationStore();
      const tracker = new OfflineRecipientDeliveryTracker();
      const conv = (await convStore.upsertDirect("usr_alice", "usr_bob", new Date())).conversation;

      // msg1 -> already delivered to dev_bob_01 before revocation (preserved)
      const r1 = await store.submitDurable({
        conversationId: conv.id,
        senderUserId: "usr_alice",
        senderDeviceId: "dev_alice_01",
        clientMessageId: randomUUID(),
        protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
        encryptedEnvelope: makeOpaqueTestEnvelope("dev_bob_01", "dev_alice_01"),
        conversationStore: convStore,
      });
      // msg2 -> queued/undelivered for dev_bob_01 (must be purged when dev_bob_01 revoked)
      const r2 = await store.submitDurable({
        conversationId: conv.id,
        senderUserId: "usr_alice",
        senderDeviceId: "dev_alice_01",
        clientMessageId: randomUUID(),
        protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
        encryptedEnvelope: makeOpaqueTestEnvelope("dev_bob_01", "dev_alice_01"),
        conversationStore: convStore,
      });
      // msg3 -> addressed to replacement dev_bob_02 (must be preserved)
      const r3 = await store.submitDurable({
        conversationId: conv.id,
        senderUserId: "usr_alice",
        senderDeviceId: "dev_alice_01",
        clientMessageId: randomUUID(),
        protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
        encryptedEnvelope: makeOpaqueTestEnvelope("dev_bob_02", "dev_alice_01"),
        conversationStore: convStore,
      });
      if (!r1.ok || !r2.ok || !r3.ok) throw new Error("submitDurable failed");

      tracker.registerCommittedMessage(r1.record, conv);
      tracker.registerCommittedMessage(r2.record, conv);
      tracker.registerCommittedMessage(r3.record, conv);
      tracker.recordDeliveryEvidence({
        messageId: r1.record.id,
        actorUserId: "usr_bob",
        actorDeviceId: "dev_bob_01",
        decrypted: true,
      });

      const purged = await store.deleteUndeliveredForRecipientDevice({
        conversationIds: [conv.id],
        recipientUserId: "usr_bob",
        recipientDeviceId: "dev_bob_01",
        isDelivered: (id) => tracker.isDelivered(id),
      });
      expect(purged).toBe(1);

      const remaining = await store.listByConversation(conv.id);
      expect(remaining.map((r) => r.id)).toEqual([r1.record.id, r3.record.id]);
    }
  });

  it("holds missing-key placeholders on locked reconnect and recovers decryption + delivery evidence once recipient key unseals", async () => {
    const [alice, bob] = await Promise.all([
      OlmAccountDevice.create({ deviceId: "dev_alice_lock_01" }),
      OlmAccountDevice.create({ deviceId: "dev_bob_lock_02" }),
    ]);
    try {
      const bobBundle = bob.toPublicKeyBundle();
      const bobTarget: OlmPeerTarget = {
        peerUserId: "usr_bob",
        peerDeviceId: bobBundle.deviceId,
        peerIdentityKey: bobBundle.identityKey,
        peerSenderKey: bobBundle.senderKey,
        peerOneTimeOrFallbackKey: bobBundle.oneTimeKeys[0]!.key,
      };
      const bobStorageKey = bob.storageKey;
      const sealedBob = await bob.sealState();
      bob.dispose();

      const convStore = new MemoryConversationStore();
      const msgStore = new MemoryMessageStore();
      const tracker = new OfflineRecipientDeliveryTracker();
      const conv = (await convStore.upsertDirect("usr_alice", "usr_bob", new Date())).conversation;

      for (const text of ["Locked 1", "লকড ২ ✨"]) {
        const enc = await alice.encryptForPeer(bobTarget, text);
        if (!enc.ok) throw new Error(enc.message);
        const committed = await msgStore.submitDurable({
          conversationId: conv.id,
          senderUserId: "usr_alice",
          senderDeviceId: alice.deviceId,
          clientMessageId: randomUUID(),
          protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
          encryptedEnvelope: enc.value.encryptedEnvelope,
          conversationStore: convStore,
        });
        if (!committed.ok) throw new Error(committed.code);
        tracker.registerCommittedMessage(committed.record, conv);
      }

      const fetcher: HistoryPageFetcher = {
        async fetchPage(input): Promise<HistoryPageResponse> {
          const decoded = input.after
            ? decodeHistoryAfterReference(input.after, input.conversationId)
            : null;
          const afterSeq = decoded && decoded.ok && decoded.value ? decoded.value.seq : 0;
          const page = await msgStore.queryHistoryPage({
            conversationId: input.conversationId,
            limit: input.limit ?? 50,
            beforeSeq: null,
            afterSeq,
          });
          return {
            items: page.items.map(toHistoryWireItem),
            nextCursor: null,
            hasMore: page.hasMore,
            latestSeq: page.latestSeq,
          };
        },
      };

      const emittedEvidence: RecipientDeliveryEvidence[] = [];
      const sync = new ConversationCatchUpSynchronizer({
        accountId: "usr_bob",
        conversationId: conv.id,
        device: null,
        historyClient: fetcher,
        onDeliveryEvidence: (evs) => {
          for (const ev of evs) {
            emittedEvidence.push(ev);
            tracker.recordDeliveryEvidence({
              messageId: ev.messageId,
              actorUserId: "usr_bob",
              actorDeviceId: ev.recipientDeviceId,
              decrypted: true,
            });
          }
        },
      });

      const lockedCatchUp = await sync.runCatchUp();
      expect(lockedCatchUp.ok).toBe(true);
      expect(sync.getRecoverableFailureCount()).toBe(2);
      expect(emittedEvidence).toHaveLength(0);
      expect(sync.getItems().every((i) => i.kind === "decryption_failed")).toBe(true);
      expect(
        tracker.listSenderConversationView(conv.id, "usr_alice").every((r) => r.stage === "sent"),
      ).toBe(true);

      const unsealed = await OlmAccountDevice.unsealState(sealedBob, bobStorageKey);
      expect(unsealed.ok).toBe(true);
      if (!unsealed.ok) return;

      sync.setDevice(unsealed.value);
      const retryRes = await sync.retryRecoverableMessages();
      expect(retryRes.stale).toBe(false);
      expect(retryRes.retriedCount).toBe(2);
      expect(retryRes.decryptedCount).toBe(2);
      expect(retryRes.stillFailedCount).toBe(0);
      expect(sync.getRecoverableFailureCount()).toBe(0);
      expect(emittedEvidence).toHaveLength(2);
      expect(sync.getItems().map((i) => (i.kind === "decrypted" ? i.plaintext : null))).toEqual([
        "Locked 1",
        "লকড ২ ✨",
      ]);
      expect(
        tracker
          .listSenderConversationView(conv.id, "usr_alice")
          .every((r) => r.stage === "delivered"),
      ).toBe(true);

      sync.dispose();
      unsealed.value.dispose();
    } finally {
      alice.dispose();
    }
  });

  it("decrypts multiple one-way offline PreKey messages after unsealState and deduplicates replay to one logical message", async () => {
    const [alice, bob] = await Promise.all([
      OlmAccountDevice.create({ deviceId: "dev_alice_pk_01" }),
      OlmAccountDevice.create({ deviceId: "dev_bob_pk_02" }),
    ]);
    try {
      const bobBundle = bob.toPublicKeyBundle();
      const bobTarget: OlmPeerTarget = {
        peerUserId: "usr_bob",
        peerDeviceId: bobBundle.deviceId,
        peerIdentityKey: bobBundle.identityKey,
        peerSenderKey: bobBundle.senderKey,
        peerOneTimeOrFallbackKey: bobBundle.oneTimeKeys[0]!.key,
      };
      const bobStorageKey = bob.storageKey;
      const sealedBob = await bob.sealState();
      bob.dispose();

      const convStore = new MemoryConversationStore();
      const msgStore = new MemoryMessageStore();
      const conv = (await convStore.upsertDirect("usr_alice", "usr_bob", new Date())).conversation;

      const offlineTexts = [
        "Offline PreKey #1",
        "Offline PreKey #2 — বাংলা",
        "Offline PreKey #3 🚀",
      ];
      for (const text of offlineTexts) {
        const enc = await alice.encryptForPeer(bobTarget, text);
        if (!enc.ok) throw new Error(enc.message);
        const committed = await msgStore.submitDurable({
          conversationId: conv.id,
          senderUserId: "usr_alice",
          senderDeviceId: alice.deviceId,
          clientMessageId: randomUUID(),
          protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
          encryptedEnvelope: enc.value.encryptedEnvelope,
          conversationStore: convStore,
        });
        if (!committed.ok) throw new Error(committed.code);
      }

      const unsealed = await OlmAccountDevice.unsealState(sealedBob, bobStorageKey);
      if (!unsealed.ok) throw new Error(unsealed.message);

      const onEvidence = vi.fn();
      const storedRows = (await msgStore.listByConversation(conv.id)).map(toHistoryWireItem);
      const fetcher: HistoryPageFetcher = {
        async fetchPage(input): Promise<HistoryPageResponse> {
          const decoded = input.after
            ? decodeHistoryAfterReference(input.after, input.conversationId)
            : null;
          const afterSeq = decoded && decoded.ok && decoded.value ? decoded.value.seq : 0;
          const items = storedRows.filter((r) => r.seq > afterSeq);
          return {
            items,
            nextCursor: null,
            hasMore: false,
            latestSeq: storedRows[storedRows.length - 1]?.seq ?? 0,
          };
        },
      };

      const sync = new ConversationCatchUpSynchronizer({
        accountId: "usr_bob",
        conversationId: conv.id,
        device: unsealed.value,
        historyClient: fetcher,
        onDeliveryEvidence: onEvidence,
      });

      const catchUp = await sync.runCatchUp();
      expect(catchUp.ok).toBe(true);
      expect(catchUp.appliedCount).toBe(3);

      // Replaying live event for an already-applied PreKey message must deduplicate cleanly.
      const dupAction = await sync.onLiveMessage(storedRows[1]!);
      expect(dupAction).toEqual({ action: "duplicate" });
      expect(onEvidence).toHaveBeenCalledTimes(1);
      expect(sync.getDeliveryEvidence()).toHaveLength(3);
      expect(sync.getItems().map((i) => (i.kind === "decrypted" ? i.plaintext : null))).toEqual(
        offlineTexts,
      );

      sync.dispose();
      unsealed.value.dispose();
    } finally {
      alice.dispose();
    }
  });
});
