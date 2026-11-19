import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MESSAGE_ALLOWED_PROTOCOL_VERSION,
  MESSAGE_SCHEMA_VERSION,
  type MessageSendInput,
  type MessageSendResponse,
} from "@chat/contracts";
import {
  OlmAccountDevice,
  OutboxCryptoError,
  assertNoOutboxPlaintextOrSecrets,
  assertValidOutboxStorageKey,
  createInMemoryIdbFactory,
  createSharedFakeLockManager,
  generateOutboxStorageKey,
  sealOutboxEntry,
  unsealOutboxEntry,
} from "@chat/crypto";

import {
  MessageSendApiError,
  type PreparedEncryptedSend,
} from "../../apps/web/src/features/chat/send.js";
import { buildSendStateBanners } from "../../apps/web/src/features/chat/send-state.js";
import { translate } from "../../apps/web/src/i18n/core.js";
import {
  EncryptedIndexedDbOutboxStorageAdapter,
  OutboxStorageError,
  SendOutboxCoordinator,
  computeClientPayloadHash,
  createQueuedOutboxEntry,
  markAttemptStarted,
  type PreparedMessageSender,
} from "../../apps/web/src/lib/outbox/index.js";

function makeValidEnvelope(seed = "1", senderDeviceId = "dev-alice-01"): string {
  const payload = {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
    senderDeviceId,
    recipientDeviceId: "dev-bob-01",
    senderIdentityKey: "a".repeat(43),
    senderCurve25519Key: "b".repeat(43),
    sessionId: "session-p209-unit",
    messageIndex: 0,
    messageType: 0,
    ciphertext: Buffer.from(`sealed-olm-ciphertext-${seed}-0123456789abcdef`, "utf8").toString(
      "base64url",
    ),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function makePrepared(
  conversationId = "conv_p209_unit",
  clientMessageId = randomUUID(),
  seed = "1",
): PreparedEncryptedSend {
  const payload: MessageSendInput = {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    clientMessageId,
    senderDeviceId: "dev-alice-01",
    protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
    encryptedEnvelope: makeValidEnvelope(seed),
  };
  return { conversationId, payload };
}

function makeAck(
  prepared: PreparedEncryptedSend,
  seq = 1,
  senderUserId = "user-a",
): MessageSendResponse {
  return {
    idempotent: false,
    message: {
      messageId: `msg_p209_${seq}`,
      conversationId: prepared.conversationId,
      seq,
      senderUserId,
      senderDeviceId: prepared.payload.senderDeviceId,
      clientMessageId: prepared.payload.clientMessageId,
      protocolVersion: prepared.payload.protocolVersion,
      committedAt: "2026-11-20T00:10:00.000Z",
      schemaVersion: 1,
    },
  };
}

describe("P2-09 unit — AES-256-GCM outbox crypto, key separation, IndexedDB persistence & Web Locks", () => {
  it("generates a dedicated non-extractable AES-256-GCM key and forbids extractable keys or Olm key reuse (DEC-021 §6.1)", async () => {
    const outboxKey = await generateOutboxStorageKey();
    expect(outboxKey.extractable).toBe(false);
    expect(outboxKey.type).toBe("secret");
    expect((outboxKey.algorithm as AesKeyAlgorithm).name).toBe("AES-GCM");
    expect((outboxKey.algorithm as AesKeyAlgorithm).length).toBe(256);
    assertValidOutboxStorageKey(outboxKey);

    const extractableKey = await globalThis.crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    expect(() => assertValidOutboxStorageKey(extractableKey)).toThrowError(OutboxCryptoError);

    const wrongAlgKey = await globalThis.crypto.subtle.generateKey(
      { name: "AES-CBC", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    expect(() => assertValidOutboxStorageKey(wrongAlgKey)).toThrowError(OutboxCryptoError);

    const olmDevice = await OlmAccountDevice.create({ deviceId: "dev-reuse-check-01" });
    try {
      expect(() =>
        assertValidOutboxStorageKey(olmDevice.storageKey, {
          forbiddenKeys: [olmDevice.storageKey],
        }),
      ).toThrowError(/must not reuse/i);
    } finally {
      olmDevice.dispose();
    }
  });

  it("seals and unseals outbox entries with metadata AAD binding and rejects tampered metadata, ciphertexts, and plaintext/secret leaks", async () => {
    const key = await generateOutboxStorageKey();
    const otherKey = await generateOutboxStorageKey();
    const prep = makePrepared();
    const payloadHash = await computeClientPayloadHash({
      conversationId: prep.conversationId,
      senderUserId: "user-a",
      senderDeviceId: prep.payload.senderDeviceId,
      clientMessageId: prep.payload.clientMessageId,
      protocolVersion: prep.payload.protocolVersion,
      encryptedEnvelope: prep.payload.encryptedEnvelope,
    });
    const entry = createQueuedOutboxEntry({
      accountId: "user-a",
      conversationId: prep.conversationId,
      payload: prep.payload,
      payloadHash,
      nowMs: 1_763_600_000_000,
    });

    const sealed = await sealOutboxEntry({
      meta: {
        schemaVersion: 1,
        accountId: entry.accountId,
        conversationId: entry.conversationId,
        clientMessageId: entry.clientMessageId,
        senderDeviceId: entry.senderDeviceId,
        protocolVersion: entry.payload.protocolVersion,
        payloadHash: entry.payloadHash,
        createdAtMs: entry.createdAtMs,
        updatedAtMs: entry.updatedAtMs,
      },
      keyId: "key-v1",
      key,
      inner: entry,
    });

    const rawSerialized = JSON.stringify(sealed);
    expect(rawSerialized).not.toContain(prep.payload.encryptedEnvelope);
    expect(rawSerialized).not.toContain("plaintext");

    const unsealed = await unsealOutboxEntry<typeof entry>({
      sealed,
      expectedAccountId: "user-a",
      expectedKeyId: "key-v1",
      key,
    });
    expect(unsealed).toEqual(entry);

    // Wrong key & wrong account must fail
    await expect(
      unsealOutboxEntry({ sealed, expectedAccountId: "user-a", key: otherKey }),
    ).rejects.toThrowError(/AES-256-GCM authentication check failed/i);
    await expect(
      unsealOutboxEntry({ sealed, expectedAccountId: "user-b", key }),
    ).rejects.toThrowError(/different account/i);

    // AAD covers every metadata field
    await expect(
      unsealOutboxEntry({
        sealed: { ...sealed, conversationId: "conv_forged" },
        expectedAccountId: "user-a",
        key,
      }),
    ).rejects.toThrowError(/AES-256-GCM authentication check failed/i);
    await expect(
      unsealOutboxEntry({
        sealed: { ...sealed, payloadHash: "f".repeat(64) },
        expectedAccountId: "user-a",
        key,
      }),
    ).rejects.toThrowError(/AES-256-GCM authentication check failed/i);

    // Plaintext & private key guards
    expect(() => assertNoOutboxPlaintextOrSecrets({ plaintext: "forbidden body" })).toThrowError(
      /FORBIDDEN_PLAINTEXT_FIELD|prohibited/i,
    );
    expect(() => assertNoOutboxPlaintextOrSecrets({ privateKey: "forbidden secret" })).toThrowError(
      /prohibited/i,
    );
    const badEnvelope = Buffer.from(
      JSON.stringify({ schemaVersion: 1, body: "oops-plaintext", ciphertext: "abc" }),
      "utf8",
    ).toString("base64url");
    expect(() => assertNoOutboxPlaintextOrSecrets({ encryptedEnvelope: badEnvelope })).toThrowError(
      /decoded encryptedEnvelope/i,
    );
  });

  it("persists queued & sending items encrypted in IndexedDB, reconciles sending->unknown on reload, and purges sent & revoked entries (TC-CHAT-005)", async () => {
    const idbFactory = createInMemoryIdbFactory();
    const lockManager = createSharedFakeLockManager();
    const storage1 = new EncryptedIndexedDbOutboxStorageAdapter({
      idbFactory,
      lockManager,
      requireWebLocks: true,
    });

    const pQueued = makePrepared("conv_ab", randomUUID(), "queued");
    const pSending = makePrepared("conv_ab", randomUUID(), "sending");
    const pHashQueued = await computeClientPayloadHash({
      conversationId: pQueued.conversationId,
      senderUserId: "user-a",
      senderDeviceId: pQueued.payload.senderDeviceId,
      clientMessageId: pQueued.payload.clientMessageId,
      protocolVersion: pQueued.payload.protocolVersion,
      encryptedEnvelope: pQueued.payload.encryptedEnvelope,
    });
    const pHashSending = await computeClientPayloadHash({
      conversationId: pSending.conversationId,
      senderUserId: "user-a",
      senderDeviceId: pSending.payload.senderDeviceId,
      clientMessageId: pSending.payload.clientMessageId,
      protocolVersion: pSending.payload.protocolVersion,
      encryptedEnvelope: pSending.payload.encryptedEnvelope,
    });

    const recQueued = createQueuedOutboxEntry({
      accountId: "user-a",
      conversationId: pQueued.conversationId,
      payload: pQueued.payload,
      payloadHash: pHashQueued,
      nowMs: 1000,
    });
    const recSending = markAttemptStarted(
      createQueuedOutboxEntry({
        accountId: "user-a",
        conversationId: pSending.conversationId,
        payload: pSending.payload,
        payloadHash: pHashSending,
        nowMs: 1001,
      }),
      1002,
    );
    await storage1.saveAll("user-a", [recQueued, recSending]);

    const atRestBefore = await storage1.inspectAtRest("user-a");
    expect(atRestBefore.hasKey).toBe(true);
    expect(atRestBefore.keyExtractable).toBe(false);
    expect(atRestBefore.sealedEntries).toHaveLength(2);
    const dumpedJson = JSON.stringify(atRestBefore.sealedEntries);
    expect(dumpedJson).not.toContain(pQueued.payload.encryptedEnvelope);
    expect(dumpedJson).not.toContain(pSending.payload.encryptedEnvelope);

    // Reload into a brand-new adapter + coordinator over the same IndexedDB
    let now = 2000;
    const sendSpy = vi.fn(async (prep: PreparedEncryptedSend) => makeAck(prep, 10));
    const storage2 = new EncryptedIndexedDbOutboxStorageAdapter({
      idbFactory,
      lockManager,
      requireWebLocks: true,
    });
    const coordinator = new SendOutboxCoordinator({
      accountId: "user-a",
      activeConversationId: "conv_ab",
      sender: { sendPrepared: sendSpy },
      storage: storage2,
      online: false,
      nowMs: () => now,
      scheduleTimer: () => 0,
      cancelTimer: () => {},
    });

    await coordinator.reconcileAfterReload();
    const afterReload = coordinator.getSnapshot().entriesForActiveConversation;
    expect(afterReload).toHaveLength(2);
    expect(
      afterReload.find((e) => e.clientMessageId === pQueued.payload.clientMessageId)?.status,
    ).toBe("queued");
    const reloadedSending = afterReload.find(
      (e) => e.clientMessageId === pSending.payload.clientMessageId,
    )!;
    expect(reloadedSending.status).toBe("unknown");
    expect(reloadedSending.payload.encryptedEnvelope).toBe(pSending.payload.encryptedEnvelope);

    // Flush online -> sent items are evicted from IndexedDB outbox_entries, cached in meta
    now += 1000;
    await coordinator.setOnline(true);
    expect(sendSpy).toHaveBeenCalledTimes(2);
    const afterFlushRest = await storage2.inspectAtRest("user-a");
    expect(afterFlushRest.sealedEntries).toHaveLength(0);
    expect(afterFlushRest.meta?.pendingCount).toBe(0);
    expect(
      await storage2.getAcceptedReceipt("user-a", pQueued.payload.clientMessageId),
    ).toBeTruthy();

    // Queue offline then revoke device -> UI shows device_revoked while IndexedDB purges queued ciphertext
    await coordinator.setOnline(false);
    const revPrep = makePrepared("conv_ab", randomUUID(), "revoked");
    await coordinator.submitPrepared(revPrep);
    expect((await storage2.inspectAtRest("user-a")).sealedEntries).toHaveLength(1);

    await coordinator.onDeviceRevoked();
    expect(
      coordinator
        .getSnapshot()
        .entriesForActiveConversation.find(
          (e) => e.clientMessageId === revPrep.payload.clientMessageId,
        )?.failureReason,
    ).toBe("device_revoked");
    expect((await storage2.inspectAtRest("user-a")).sealedEntries).toHaveLength(0);
  });

  it("handles storage unavailability, key eviction, entry eviction, and ciphertext tamper safely with EN/BN banners", async () => {
    const missingIdbStorage = new EncryptedIndexedDbOutboxStorageAdapter({ idbFactory: null });
    await expect(missingIdbStorage.loadAll("user-a")).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    } satisfies Partial<OutboxStorageError>);

    const missingLocksStorage = new EncryptedIndexedDbOutboxStorageAdapter({
      idbFactory: createInMemoryIdbFactory(),
      lockManager: null,
      requireWebLocks: true,
    });
    await expect(missingLocksStorage.loadAll("user-a")).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    } satisfies Partial<OutboxStorageError>);

    const idbFactory = createInMemoryIdbFactory();
    const lockManager = createSharedFakeLockManager();
    const storage = new EncryptedIndexedDbOutboxStorageAdapter({ idbFactory, lockManager });
    const coordinator = new SendOutboxCoordinator({
      accountId: "user-a",
      activeConversationId: "conv_ab",
      sender: { sendPrepared: async (p) => makeAck(p, 1) },
      storage,
      online: false,
      nowMs: () => 5000,
      scheduleTimer: () => 0,
      cancelTimer: () => {},
    });

    // Key eviction -> STORAGE_CLEARED
    const prep1 = makePrepared("conv_ab");
    await coordinator.submitPrepared(prep1);
    await storage.simulateKeyEviction("user-a");
    await coordinator.reconcileAfterReload();
    expect(coordinator.getSnapshot().storageNoticeCode).toBe("STORAGE_CLEARED");
    expect(coordinator.getSnapshot().entriesForActiveConversation).toHaveLength(0);

    // Entry eviction -> STORAGE_CLEARED
    const prep2 = makePrepared("conv_ab");
    await coordinator.submitPrepared(prep2);
    await storage.simulateEntriesEviction("user-a");
    await coordinator.reconcileAfterReload();
    expect(coordinator.getSnapshot().storageNoticeCode).toBe("STORAGE_CLEARED");

    // Ciphertext tamper -> CORRUPT_OUTBOX
    const prep3 = makePrepared("conv_ab");
    await coordinator.submitPrepared(prep3);
    const tampered = await storage.simulateCiphertextTamper(
      "user-a",
      prep3.payload.clientMessageId,
    );
    expect(tampered).toBe(true);
    await coordinator.hydrate();
    expect(coordinator.getSnapshot().storageNoticeCode).toBe("CORRUPT_OUTBOX");
    expect(coordinator.getSnapshot().storageAvailable).toBe(false);

    const corruptBanners = buildSendStateBanners(coordinator.getSnapshot());
    expect(corruptBanners.some((b) => b.descriptionKey === "sendState.detail.corruptOutbox")).toBe(
      true,
    );
    expect(translate("en", "sendState.detail.corruptOutbox")).toContain("integrity verification");
    expect(translate("bn", "sendState.detail.corruptOutbox")).toContain("অখণ্ডতা যাচাই");

    // Simulated IndexedDB unavailability during write -> STORAGE_UNAVAILABLE
    idbFactory.setAvailable(false);
    await coordinator.submitPrepared(makePrepared("conv_ab"));
    expect(coordinator.getSnapshot().storageNoticeCode).toBe("STORAGE_UNAVAILABLE");
    expect(coordinator.getSnapshot().storageAvailable).toBe(false);
    expect(new MessageSendApiError(503, "TEMPORARILY_UNAVAILABLE", true, "unknown").retryable).toBe(
      true,
    );
  });

  it("serializes concurrent multi-tab flushes under Web Locks so only one network send fires (DEC-021 §6.1)", async () => {
    const idbFactory = createInMemoryIdbFactory();
    const lockManager = createSharedFakeLockManager();
    let networkCalls = 0;

    const slowSender: PreparedMessageSender = {
      async sendPrepared(prepared: PreparedEncryptedSend) {
        networkCalls += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        return makeAck(prepared, 42);
      },
    };

    const storageA = new EncryptedIndexedDbOutboxStorageAdapter({
      idbFactory,
      lockManager,
      requireWebLocks: true,
    });
    const storageB = new EncryptedIndexedDbOutboxStorageAdapter({
      idbFactory,
      lockManager,
      requireWebLocks: true,
    });

    const tabA = new SendOutboxCoordinator({
      accountId: "user-a",
      activeConversationId: "conv_race",
      sender: slowSender,
      storage: storageA,
      online: false,
      nowMs: () => 10_000,
      scheduleTimer: () => 0,
      cancelTimer: () => {},
    });
    const tabB = new SendOutboxCoordinator({
      accountId: "user-a",
      activeConversationId: "conv_race",
      sender: slowSender,
      storage: storageB,
      online: false,
      nowMs: () => 10_000,
      scheduleTimer: () => 0,
      cancelTimer: () => {},
    });

    const prepared = makePrepared("conv_race");
    await tabA.submitPrepared(prepared);
    await tabB.hydrate();

    // Both tabs go online at the exact same moment
    await Promise.all([tabA.setOnline(true), tabB.setOnline(true)]);

    expect(networkCalls).toBe(1);
    const snapA = tabA.getSnapshot().entriesForActiveConversation[0]!;
    const snapB = tabB.getSnapshot().entriesForActiveConversation[0]!;
    expect(snapA.status).toBe("sent");
    expect(snapB.status).toBe("sent");
    expect(snapA.committedMessageId).toBe(snapB.committedMessageId);
    expect(snapA.committedSeq).toBe(42);
    expect(snapB.committedSeq).toBe(42);
    expect((await storageA.inspectAtRest("user-a")).sealedEntries).toHaveLength(0);
  });

  it("warns on logout when pending entries exist and deletes both entries and local CryptoKey once confirmed", async () => {
    const idbFactory = createInMemoryIdbFactory();
    const lockManager = createSharedFakeLockManager();
    const storage = new EncryptedIndexedDbOutboxStorageAdapter({ idbFactory, lockManager });
    const coordinator = new SendOutboxCoordinator({
      accountId: "user-a",
      activeConversationId: "conv_logout",
      sender: { sendPrepared: async (p) => makeAck(p, 1) },
      storage,
      online: false,
      nowMs: () => 15_000,
      scheduleTimer: () => 0,
      cancelTimer: () => {},
    });

    await coordinator.submitPrepared(makePrepared("conv_logout"));
    const firstAttempt = await coordinator.requestLogout();
    expect(firstAttempt).toEqual({
      completed: false,
      requiresConfirmation: true,
      pendingCount: 1,
    });
    expect(coordinator.getSnapshot().logoutWarningPendingCount).toBe(1);
    expect((await storage.inspectAtRest("user-a")).hasKey).toBe(true);
    expect((await storage.inspectAtRest("user-a")).sealedEntries).toHaveLength(1);

    const warnBanners = buildSendStateBanners(coordinator.getSnapshot());
    expect(warnBanners.some((b) => b.titleKey === "sendState.banner.logoutWarningTitle")).toBe(
      true,
    );
    expect(translate("bn", "sendState.banner.logoutWarningTitle")).toContain("আউটবক্স");

    coordinator.cancelLogoutRequest();
    expect(coordinator.getSnapshot().logoutWarningPendingCount).toBeNull();

    const confirmed = await coordinator.requestLogout({ confirmDiscardPending: true });
    expect(confirmed).toEqual({
      completed: true,
      requiresConfirmation: false,
      pendingCount: 1,
    });
    const afterLogout = await storage.inspectAtRest("user-a");
    expect(afterLogout.hasKey).toBe(false);
    expect(afterLogout.sealedEntries).toHaveLength(0);
    expect(afterLogout.meta).toBeNull();
  });
});
