import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import {
  HISTORY_PAGE_DEFAULT,
  HISTORY_PAGE_MAX,
  MESSAGE_ALLOWED_PROTOCOL_VERSION,
  MESSAGE_SCHEMA_VERSION,
  PUBLIC_FIELDS,
  decodeHistoryAfterReference,
  decodeHistoryCursor,
  encodeCursor,
  encodeHistoryCursor,
  hasOnlyFields,
  successEnvelope,
  validateConversationHistoryQuery,
  validateHistoryPageResponse,
  type HistoryMessageItem,
  type HistoryPageResponse,
} from "@chat/contracts";
import { OlmAccountDevice } from "@chat/crypto";

import {
  MESSAGE_READ_CONCERN,
  MongoMessageStore,
  type MongoMessageCollectionLike,
  type MongoMessageDocument,
  type MongoMessageFindCursorLike,
} from "../../apps/api/src/messages/store.js";
import {
  HistoryApiError,
  HistoryClient,
  HistoryController,
  findSequenceGaps,
  mergeHistoryMessages,
  type HistoryFetchPageInput,
  type HistoryPageFetcher,
  type HistoryViewState,
} from "../../apps/web/src/features/chat/history.js";
import type { ReceivedTimelineMessage } from "../../apps/web/src/features/chat/receive.js";

const disposables: OlmAccountDevice[] = [];

async function makeDevice(deviceId: string): Promise<OlmAccountDevice> {
  const device = await OlmAccountDevice.create({ deviceId });
  disposables.push(device);
  return device;
}

function makeWireItem(
  seq: number,
  conversationId = "conv_hist_01",
  encryptedEnvelope = "ZW5jcnlwdGVk",
  senderDeviceId = "dev_alice_01",
): HistoryMessageItem {
  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    messageId: `msg_hist_${conversationId}_${seq}`,
    conversationId,
    seq,
    senderUserId: "usr_alice_01",
    senderDeviceId,
    clientMessageId: randomUUID(),
    protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
    encryptedEnvelope,
    committedAt: "2026-11-19T12:00:00.000Z",
  };
}

afterEach(() => {
  while (disposables.length > 0) {
    disposables.pop()?.dispose();
  }
});

describe("P2-07 — history cursor & query contracts (INT-006, TC-HIST-001)", () => {
  it("encodes and decodes conversation-scoped cursors and rejects foreign/tampered/unscoped cursors with INVALID_CURSOR", () => {
    const cursorA = encodeHistoryCursor("conv_alpha", 42);
    expect(decodeHistoryCursor(cursorA, "conv_alpha")).toEqual({
      ok: true,
      value: { v: 1, conversationId: "conv_alpha", seq: 42 },
    });

    // Foreign-conversation cursor must fail with INVALID_CURSOR
    const foreign = decodeHistoryCursor(cursorA, "conv_beta");
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.code).toBe("INVALID_CURSOR");

    // Unscoped P1-05 v0 cursor must fail scoped history cursor check
    const unscoped = decodeHistoryCursor(encodeCursor(42), "conv_alpha");
    expect(unscoped.ok).toBe(false);
    if (!unscoped.ok) expect(unscoped.code).toBe("INVALID_CURSOR");

    // Tampered, empty, oversized, wrong-type cursors fail closed
    for (const bad of [
      "",
      "not-valid-base64!!!",
      "A",
      Buffer.from(JSON.stringify({ v: 2, conversationId: "conv_alpha", seq: 1 })).toString(
        "base64url",
      ),
      Buffer.from(JSON.stringify({ v: 1, conversationId: "conv_alpha", seq: -1 })).toString(
        "base64url",
      ),
      Buffer.from(JSON.stringify({ v: 1, conversationId: "conv_alpha", seq: 1.5 })).toString(
        "base64url",
      ),
      Buffer.from(
        JSON.stringify({ v: 1, conversationId: "conv_alpha", seq: 1, extra: 1 }),
      ).toString("base64url"),
      "x".repeat(513),
    ]) {
      const res = decodeHistoryCursor(bad, "conv_alpha");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("INVALID_CURSOR");
    }

    expect(decodeHistoryCursor(["c1"] as unknown, "conv_alpha")).toMatchObject({
      ok: false,
      code: "INVALID_CURSOR",
    });
  });

  it("validates before/after references, strict 50/100 page bounds, and disallows offsets or unknown params", () => {
    const defaultQuery = validateConversationHistoryQuery({}, "conv_alpha");
    expect(defaultQuery).toEqual({
      ok: true,
      value: {
        limit: HISTORY_PAGE_DEFAULT,
        before: null,
        after: null,
        mode: "before",
      },
    });

    const maxQuery = validateConversationHistoryQuery(
      { limit: String(HISTORY_PAGE_MAX) },
      "conv_alpha",
    );
    expect(maxQuery).toMatchObject({ ok: true, value: { limit: 100, mode: "before" } });

    const numericAfter = decodeHistoryAfterReference("42", "conv_alpha");
    expect(numericAfter).toEqual({
      ok: true,
      value: { v: 1, conversationId: "conv_alpha", seq: 42 },
    });
    const scopedAfter = decodeHistoryAfterReference(
      encodeHistoryCursor("conv_alpha", 42),
      "conv_alpha",
    );
    expect(scopedAfter).toEqual(numericAfter);

    for (const badAfter of ["-1", "1.5", "01", "abc", encodeHistoryCursor("conv_beta", 5)]) {
      expect(decodeHistoryAfterReference(badAfter, "conv_alpha")).toMatchObject({
        ok: false,
        code: "INVALID_CURSOR",
      });
    }

    // Bounds > 100 or <= 0 or non-integer rejected without truncation
    for (const badLimit of ["101", 101, "0", 0, "-1", "1e2", " 50 ", ["50"]]) {
      expect(validateConversationHistoryQuery({ limit: badLimit }, "conv_alpha")).toMatchObject({
        ok: false,
        code: "INVALID_REQUEST",
      });
    }

    // Offset/filter/operator/both-cursors rejected
    expect(validateConversationHistoryQuery({ offset: "10" }, "conv_alpha")).toMatchObject({
      ok: false,
      code: "INVALID_REQUEST",
    });
    expect(validateConversationHistoryQuery({ $gt: "1" }, "conv_alpha")).toMatchObject({
      ok: false,
      code: "INVALID_REQUEST",
    });
    expect(
      validateConversationHistoryQuery(
        { before: encodeHistoryCursor("conv_alpha", 10), after: "1" },
        "conv_alpha",
      ),
    ).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });

  it("validates HistoryPageResponse allowlists, ascending seq order, duplicate rejection, and cursor consistency", () => {
    const valid: HistoryPageResponse = {
      items: [makeWireItem(3), makeWireItem(4), makeWireItem(5)],
      nextCursor: encodeHistoryCursor("conv_hist_01", 3),
      hasMore: true,
    };
    expect(hasOnlyFields(valid, PUBLIC_FIELDS.history)).toBe(true);
    expect(hasOnlyFields(valid.items[0], PUBLIC_FIELDS.historyItem)).toBe(true);
    expect(validateHistoryPageResponse(valid, "conv_hist_01").ok).toBe(true);

    // Rejects payloadHash or plaintext leaks
    expect(
      validateHistoryPageResponse(
        { ...valid, items: [{ ...valid.items[0], payloadHash: "abc" }] },
        "conv_hist_01",
      ).ok,
    ).toBe(false);

    // Rejects non-ascending order, duplicate messageId, foreign item, or end-of-history cursor mismatch
    expect(
      validateHistoryPageResponse(
        { ...valid, items: [makeWireItem(5), makeWireItem(4)] },
        "conv_hist_01",
      ).ok,
    ).toBe(false);
    expect(
      validateHistoryPageResponse(
        { ...valid, items: [makeWireItem(4, "conv_other")] },
        "conv_hist_01",
      ).ok,
    ).toBe(false);
    expect(
      validateHistoryPageResponse(
        {
          items: [makeWireItem(1)],
          nextCursor: encodeHistoryCursor("conv_hist_01", 1),
          hasMore: false,
        },
        "conv_hist_01",
      ).ok,
    ).toBe(false);
  });
});

describe("P2-07 — MongoMessageStore.queryHistoryPage contract", () => {
  it("queries with majority readConcern, descending/ascending seq index sort, and limit + 1 lookahead", async () => {
    const docs: MongoMessageDocument[] = [1, 3, 4, 6, 7].map((seq) => ({
      _id: `msg_${seq}`,
      conversationId: "conv_mongo_1",
      seq,
      senderUserId: "usr_alice",
      senderDeviceId: "dev_alice_1",
      clientMessageId: randomUUID(),
      payloadHash: "a".repeat(64),
      protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      encryptedEnvelope: "ZW5jcnlwdGVk",
      committedAt: new Date(Date.UTC(2026, 10, 19, 12, 0, seq)),
      schemaVersion: MESSAGE_SCHEMA_VERSION,
    }));

    const recordedCalls: Array<{
      filter: Record<string, unknown>;
      options?: Record<string, unknown>;
      sort?: Record<string, 1 | -1>;
      limit?: number;
    }> = [];

    const collection: MongoMessageCollectionLike = {
      async findOne() {
        return null;
      },
      async insertOne() {
        return { acknowledged: true };
      },
      find(filter, options) {
        const call: (typeof recordedCalls)[number] = { filter, options };
        recordedCalls.push(call);

        let working = docs.filter((d) => {
          if (filter.conversationId && d.conversationId !== filter.conversationId) return false;
          const seqFilter = filter.seq as { $lt?: number; $gt?: number } | undefined;
          if (seqFilter?.$lt !== undefined && !(d.seq < seqFilter.$lt)) return false;
          if (seqFilter?.$gt !== undefined && !(d.seq > seqFilter.$gt)) return false;
          return true;
        });

        const cursor: MongoMessageFindCursorLike<MongoMessageDocument> = {
          sort(spec) {
            call.sort = spec;
            working = [...working].sort((a, b) =>
              spec.seq === -1 ? b.seq - a.seq : a.seq - b.seq,
            );
            return cursor;
          },
          limit(count) {
            call.limit = count;
            working = working.slice(0, count);
            return cursor;
          },
          async toArray() {
            return working.map((d) => ({ ...d, committedAt: new Date(d.committedAt.getTime()) }));
          },
        };
        return cursor;
      },
    };

    const store = new MongoMessageStore(collection);

    // Latest page of size 3 from [1, 3, 4, 6, 7] -> [4, 6, 7], hasMore=true
    const page1 = await store.queryHistoryPage({
      conversationId: "conv_mongo_1",
      limit: 3,
      beforeSeq: null,
      afterSeq: null,
    });
    expect(page1.items.map((i) => i.seq)).toEqual([4, 6, 7]);
    expect(page1.hasMore).toBe(true);
    expect(page1.latestSeq).toBe(7);
    expect(recordedCalls[0]?.options).toEqual({ readConcern: MESSAGE_READ_CONCERN });
    expect(recordedCalls[0]?.sort).toEqual({ seq: -1 });
    expect(recordedCalls[0]?.limit).toBe(4);

    // Older page before 4 -> [1, 3], hasMore=false (handles seq gap 2 cleanly)
    const page2 = await store.queryHistoryPage({
      conversationId: "conv_mongo_1",
      limit: 3,
      beforeSeq: 4,
      afterSeq: null,
    });
    expect(page2.items.map((i) => i.seq)).toEqual([1, 3]);
    expect(page2.hasMore).toBe(false);
    expect(recordedCalls[1]?.filter).toEqual({ conversationId: "conv_mongo_1", seq: { $lt: 4 } });

    // Catch-up after seq 1 -> [3, 4], hasMore=true, latestSeq=7
    const catchUp = await store.queryHistoryPage({
      conversationId: "conv_mongo_1",
      limit: 2,
      beforeSeq: null,
      afterSeq: 1,
    });
    expect(catchUp.items.map((i) => i.seq)).toEqual([3, 4]);
    expect(catchUp.hasMore).toBe(true);
    expect(catchUp.latestSeq).toBe(7);
  });
});

describe("P2-07 — client merge, gap detection, HistoryClient & HistoryController (TC-HIST-004, ERR-003)", () => {
  it("merges and deduplicates messages in strict ascending seq order regardless of timestamps", () => {
    const mkDecrypted = (
      seq: number,
      messageId: string,
      committedAt = "2026-11-19T12:00:00.000Z",
    ): ReceivedTimelineMessage => ({
      kind: "decrypted",
      messageId,
      conversationId: "conv_1",
      seq,
      senderUserId: "usr_a",
      senderDeviceId: "dev_a",
      committedAt,
      protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      plaintext: `msg-${seq}`,
      sessionId: "sess_1",
      messageIndex: seq - 1,
      canEmitDeliveryReceipt: true,
      canEmitReadReceipt: true,
    });
    const mkFailed = (seq: number, messageId: string): ReceivedTimelineMessage => ({
      kind: "decryption_failed",
      messageId,
      conversationId: "conv_1",
      seq,
      senderUserId: "usr_a",
      senderDeviceId: "dev_a",
      committedAt: "2026-11-19T12:00:00.000Z",
      protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      failureState: "replayed-message",
      code: "REPLAYED_OR_DUPLICATE_MESSAGE",
      recoverable: false,
      canEmitDeliveryReceipt: false,
      canEmitReadReceipt: false,
    });

    const merged = mergeHistoryMessages(
      [mkDecrypted(5, "m5"), mkDecrypted(3, "m3")],
      [
        mkFailed(5, "m5"),
        mkDecrypted(1, "m1"),
        mkDecrypted(6, "m6"),
        { ...mkDecrypted(2, "m2_foreign"), conversationId: "conv_other" },
      ],
      "conv_1",
    );
    expect(merged.map((m) => [m.seq, m.kind])).toEqual([
      [1, "decrypted"],
      [3, "decrypted"],
      [5, "decrypted"],
      [6, "decrypted"],
    ]);
    expect(findSequenceGaps(merged)).toEqual([2, 4]);
  });

  it("enforces HistoryClient Bearer auth, credentials: omit, online short-circuit, and response validation", async () => {
    let online = false;
    let fetchCalled = false;
    const offlineClient = new HistoryClient({
      apiOrigin: "https://api.example.test",
      getToken: () => "jwt-token",
      isOnline: () => online,
      fetchImpl: (async () => {
        fetchCalled = true;
        throw new Error("should not call fetch");
      }) as typeof fetch,
    });

    await expect(offlineClient.fetchPage({ conversationId: "conv_1" })).rejects.toMatchObject({
      code: "OFFLINE",
      retryable: true,
    });
    expect(fetchCalled).toBe(false);

    online = true;
    let seenInit: RequestInit | undefined;
    let seenUrl = "";
    const validClient = new HistoryClient({
      apiOrigin: "https://api.example.test",
      getToken: () => "jwt-token",
      isOnline: () => online,
      fetchImpl: (async (url, init) => {
        seenUrl = String(url);
        seenInit = init;
        return new Response(
          JSON.stringify(
            successEnvelope({
              items: [makeWireItem(2, "conv_1"), makeWireItem(3, "conv_1")],
              nextCursor: encodeHistoryCursor("conv_1", 2),
              hasMore: true,
            }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });

    const page = await validClient.fetchPage({
      conversationId: "conv_1",
      before: encodeHistoryCursor("conv_1", 4),
      limit: 2,
    });
    expect(page.items.map((i) => i.seq)).toEqual([2, 3]);
    expect(seenUrl).toContain("/api/v1/conversations/conv_1/messages?limit=2&before=");
    expect(seenInit?.credentials).toBe("omit");
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer jwt-token");
  });

  it("decrypts backward pages with real vodozemac WASM, transitions all TC-HIST-004 states, preserves content on older failure, and drops stale context (ERR-003)", async () => {
    const alice = await makeDevice("dev_alice_hist_unit");
    const bob = await makeDevice("dev_bob_hist_unit");
    const bobBundle = bob.toPublicKeyBundle();
    const preKey = bobBundle.oneTimeKeys[0]?.key ?? bobBundle.fallbackKey.key;

    const allItems: HistoryMessageItem[] = [];
    for (let seq = 1; seq <= 7; seq += 1) {
      const text = seq === 2 ? "বাংলা যুক্তাক্ষর ক্ষ 🇧🇩" : `Message ${seq}`;
      const encrypted = await alice.encryptForPeer(
        {
          peerUserId: "usr_bob",
          peerDeviceId: bob.deviceId,
          peerIdentityKey: bob.identityKey,
          peerSenderKey: bob.senderKey,
          peerOneTimeOrFallbackKey: preKey,
        },
        text,
      );
      expect(encrypted.ok).toBe(true);
      if (encrypted.ok) {
        allItems.push(
          makeWireItem(seq, "conv_1", encrypted.value.encryptedEnvelope, alice.deviceId),
        );
      }
    }

    let mode:
      | "normal"
      | "empty"
      | "offline"
      | "failed"
      | "forbidden"
      | "fail_older_once"
      | "auth_loss_older" = "normal";

    const mockFetcher: HistoryPageFetcher = {
      async fetchPage(input: HistoryFetchPageInput): Promise<HistoryPageResponse> {
        if (mode === "offline") throw new HistoryApiError(0, "OFFLINE", true);
        if (mode === "failed") {
          throw new HistoryApiError(
            503,
            "TEMPORARILY_UNAVAILABLE",
            true,
            "123e4567-e89b-42d3-a456-426614174001",
          );
        }
        if (mode === "forbidden") throw new HistoryApiError(403, "FORBIDDEN", false);
        if (mode === "empty") return { items: [], nextCursor: null, hasMore: false };
        if (mode === "fail_older_once" && input.before) {
          mode = "normal";
          throw new HistoryApiError(
            503,
            "TEMPORARILY_UNAVAILABLE",
            true,
            "123e4567-e89b-42d3-a456-426614174002",
          );
        }
        if (mode === "auth_loss_older" && input.before) {
          throw new HistoryApiError(401, "SESSION_REVOKED", false);
        }

        const beforeSeq = input.before
          ? decodeHistoryCursor(input.before, input.conversationId)
          : null;
        const limit = input.limit ?? 3;
        const matchingDesc = [...allItems]
          .filter((i) =>
            beforeSeq && beforeSeq.ok && beforeSeq.value ? i.seq < beforeSeq.value.seq : true,
          )
          .sort((a, b) => b.seq - a.seq);
        const hasMore = matchingDesc.length > limit;
        const page = matchingDesc.slice(0, limit).reverse();
        const nextCursor =
          hasMore && page.length > 0
            ? encodeHistoryCursor(input.conversationId, page[0]!.seq)
            : null;
        return { items: page, nextCursor, hasMore };
      },
    };

    const controller = new HistoryController({
      accountId: "usr_bob",
      conversationId: "conv_1",
      device: bob,
      client: mockFetcher,
      pageLimit: 3,
    });
    const observedStatuses: HistoryViewState["status"][] = [];
    controller.subscribe((s) => observedStatuses.push(s.status));

    // 1. Page 1 -> seq 5, 6, 7
    const s1 = await controller.loadInitial();
    expect(observedStatuses).toContain("loading");
    expect(s1.status).toBe("ready");
    if (s1.status === "ready") {
      expect(s1.items.map((i) => [i.seq, i.kind])).toEqual([
        [5, "decrypted"],
        [6, "decrypted"],
        [7, "decrypted"],
      ]);
      expect(s1.hasMore).toBe(true);
    }

    // 2. Transient failure on older page preserves seq 5..7 cleanly; retry recovers seq 2..4!
    mode = "fail_older_once";
    const failOlder = await controller.loadOlder();
    expect(failOlder.status).toBe("ready");
    if (failOlder.status === "ready") {
      expect(failOlder.items.map((i) => i.seq)).toEqual([5, 6, 7]);
      expect(failOlder.pageError?.requestId).toBe("123e4567-e89b-42d3-a456-426614174002");
    }

    const s2 = await controller.retry();
    expect(s2.status).toBe("ready");
    if (s2.status === "ready") {
      expect(s2.pageError).toBeNull();
      expect(s2.items.map((i) => [i.seq, i.kind])).toEqual([
        [2, "decrypted"],
        [3, "decrypted"],
        [4, "decrypted"],
        [5, "decrypted"],
        [6, "decrypted"],
        [7, "decrypted"],
      ]);
      expect(s2.items[0]?.kind === "decrypted" && s2.items[0].plaintext).toBe(
        "বাংলা যুক্তাক্ষর ক্ষ 🇧🇩",
      );
      expect(s2.hasMore).toBe(true);
    }

    // 3. Final page -> seq 1, hasMore = false
    const s3 = await controller.loadOlder();
    expect(s3.status).toBe("ready");
    if (s3.status === "ready") {
      expect(s3.items.map((i) => [i.seq, i.kind])).toEqual([
        [1, "decrypted"],
        [2, "decrypted"],
        [3, "decrypted"],
        [4, "decrypted"],
        [5, "decrypted"],
        [6, "decrypted"],
        [7, "decrypted"],
      ]);
      expect(s3.hasMore).toBe(false);
      expect(s3.nextCursor).toBeNull();
    }

    // 4. Re-test auth loss during loadOlder clears protected items
    mode = "normal";
    await controller.loadInitial();
    mode = "auth_loss_older";
    const revoked = await controller.loadOlder();
    expect(revoked.status).toBe("forbidden");
    expect(revoked.items).toEqual([]);

    // 5. Empty, offline, failed, forbidden initial states
    mode = "empty";
    expect((await controller.loadInitial()).status).toBe("empty");
    mode = "offline";
    expect((await controller.loadInitial()).status).toBe("offline");
    mode = "failed";
    expect((await controller.loadInitial()).status).toBe("failed");
    mode = "forbidden";
    expect((await controller.loadInitial()).status).toBe("forbidden");

    // 6. Key-unavailable state when device is absent (encrypted ciphertext intact, zero plaintext fallback)
    mode = "normal";
    const noKeyController = new HistoryController({
      accountId: "usr_bob",
      conversationId: "conv_1",
      device: null,
      client: mockFetcher,
      pageLimit: 3,
    });
    const noKeyState = await noKeyController.loadInitial();
    expect(noKeyState.status).toBe("key-unavailable");
    if (noKeyState.status === "key-unavailable") {
      expect(noKeyState.encryptedCount).toBe(3);
      expect(noKeyState.recoveryHref).toBe("/settings/encryption");
    }

    // 7. ERR-003 stale completion cancellation on conversation switch
    let releaseConvA!: () => void;
    const delayedFetcher: HistoryPageFetcher = {
      async fetchPage(input) {
        if (input.conversationId === "conv_stale") {
          await new Promise<void>((resolve) => {
            releaseConvA = resolve;
          });
          return { items: [allItems[0]!], nextCursor: null, hasMore: false };
        }
        return { items: [], nextCursor: null, hasMore: false };
      },
    };
    const raceController = new HistoryController({
      accountId: "usr_bob",
      conversationId: "conv_stale",
      device: bob,
      client: delayedFetcher,
    });
    const pendingStale = raceController.loadInitial();
    raceController.switchConversation("conv_fresh");
    await raceController.loadInitial();
    releaseConvA();
    await pendingStale;
    expect(raceController.getState().conversationId).toBe("conv_fresh");
    expect(raceController.getItems()).toEqual([]);
  });
});
