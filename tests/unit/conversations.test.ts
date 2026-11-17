import { describe, expect, it } from "vitest";
import {
  CONVERSATION_FORBIDDEN_FIELDS,
  CONVERSATION_SCHEMA_VERSION,
  ERROR_HTTP_STATUS,
  PUBLIC_FIELDS,
  canonicalConversationPair,
  decodeConversationCursor,
  encodeConversationCursor,
  hasOnlyFields,
  validateConversationCreateResponse,
  validateConversationDetailResponse,
  validateConversationListQuery,
  validateConversationListResponse,
  validateConversationSummary,
  validateCreateConversationRequest,
} from "@chat/contracts";
import {
  ConversationRateLimiter,
  MemoryConversationStore,
  MongoConversationStore,
  type MongoConversationCollectionLike,
  type MongoConversationDocument,
} from "../../apps/api/src/conversations/index.js";
import {
  CONVERSATION_TOMBSTONE_LABEL_KEY,
  ConversationsApiError,
  ConversationsClient,
  createRequestVersionGuard,
  mapConversationListError,
  mapConversationOpenError,
  peerAvatarDescriptor,
  toConversationOpenReadyState,
} from "../../apps/web/src/features/chat/index.js";
import { errorCopyFor } from "../../apps/web/src/i18n/errors.js";

function createMockMongoCollection(): {
  collection: MongoConversationCollectionLike;
  docsById: Map<string, MongoConversationDocument>;
  simulateNextDuplicateCode: (code: 11000 | "E11000_MSG") => void;
  injectCorruptDoc: (doc: MongoConversationDocument) => void;
} {
  const docsById = new Map<string, MongoConversationDocument>();
  const docsByPair = new Map<string, MongoConversationDocument>();
  let duplicateNext: 11000 | "E11000_MSG" | null = null;

  const cloneDoc = (doc: MongoConversationDocument): MongoConversationDocument => ({
    ...doc,
    participantIds: [...doc.participantIds],
    createdAt: new Date(doc.createdAt.getTime()),
    lastActivityAt: new Date(doc.lastActivityAt.getTime()),
  });

  const collection: MongoConversationCollectionLike = {
    async findOne(filter) {
      if (typeof filter._id === "string") {
        const doc = docsById.get(filter._id);
        return doc ? cloneDoc(doc) : null;
      }
      if (typeof filter.pairKey === "string") {
        const doc = docsByPair.get(filter.pairKey);
        return doc ? cloneDoc(doc) : null;
      }
      return null;
    },

    async findOneAndUpdate(filter, update) {
      const pairKey = String(filter.pairKey);
      const insert = (update.$setOnInsert ?? {}) as Partial<MongoConversationDocument>;

      if (duplicateNext !== null) {
        const mode = duplicateNext;
        duplicateNext = null;
        // Simulate a competing writer having inserted the canonical record right before us.
        if (
          !docsByPair.has(pairKey) &&
          insert.participantIds &&
          insert.createdAt &&
          insert.lastActivityAt
        ) {
          const winner: MongoConversationDocument = {
            _id: "conv_concurrent_winner",
            pairKey,
            participantIds: [...insert.participantIds],
            lastSeq: 0,
            createdAt: new Date(insert.createdAt.getTime()),
            lastActivityAt: new Date(insert.lastActivityAt.getTime()),
            schemaVersion: Number(insert.schemaVersion ?? CONVERSATION_SCHEMA_VERSION),
          };
          docsById.set(winner._id, winner);
          docsByPair.set(winner.pairKey, winner);
        }
        if (mode === 11000) {
          const err = new Error("duplicate key") as Error & { code: number };
          err.code = 11000;
          throw err;
        }
        throw new Error("E11000 duplicate key error collection: chat.conversations");
      }

      const existing = docsByPair.get(pairKey);
      if (existing) {
        return cloneDoc(existing);
      }

      const created: MongoConversationDocument = {
        _id: String(insert._id),
        pairKey,
        participantIds: [...(insert.participantIds ?? [])],
        lastSeq: Number(insert.lastSeq ?? 0),
        createdAt: new Date((insert.createdAt ?? new Date()).getTime()),
        lastActivityAt: new Date((insert.lastActivityAt ?? new Date()).getTime()),
        schemaVersion: Number(insert.schemaVersion ?? CONVERSATION_SCHEMA_VERSION),
      };
      docsById.set(created._id, created);
      docsByPair.set(created.pairKey, created);
      return cloneDoc(created);
    },

    find(filter) {
      const participant = typeof filter.participantIds === "string" ? filter.participantIds : null;
      const orClauses = Array.isArray(filter.$or)
        ? (filter.$or as Array<Record<string, unknown>>)
        : null;

      let matched = [...docsById.values()].filter((doc) =>
        participant ? doc.participantIds.includes(participant) : true,
      );

      if (orClauses && orClauses.length === 2) {
        const clause0 = orClauses[0]!;
        const clause1 = orClauses[1]!;
        const ltTime = (clause0.lastActivityAt as { $lt: Date }).$lt.getTime();
        const eqTime = (clause1.lastActivityAt as Date).getTime();
        const ltId = (clause1._id as { $lt: string }).$lt;
        matched = matched.filter((doc) => {
          const t = doc.lastActivityAt.getTime();
          return t < ltTime || (t === eqTime && doc._id < ltId);
        });
      }

      let limitCount = matched.length;
      const cursor = {
        sort(spec: Record<string, 1 | -1>) {
          if (spec.lastActivityAt === -1 && spec._id === -1) {
            matched.sort((a, b) => {
              const dt = b.lastActivityAt.getTime() - a.lastActivityAt.getTime();
              if (dt !== 0) return dt;
              return b._id > a._id ? 1 : b._id < a._id ? -1 : 0;
            });
          }
          return cursor;
        },
        limit(n: number) {
          limitCount = n;
          return cursor;
        },
        async toArray() {
          return matched.slice(0, limitCount).map(cloneDoc);
        },
      };
      return cursor;
    },
  };

  return {
    collection,
    docsById,
    simulateNextDuplicateCode(code) {
      duplicateNext = code;
    },
    injectCorruptDoc(doc) {
      docsById.set(doc._id, doc);
      docsByPair.set(doc.pairKey, doc);
    },
  };
}

describe("P2-03 conversation contracts", () => {
  it("maps BLOCKED -> 403 and USER_UNAVAILABLE -> 404", () => {
    expect(ERROR_HTTP_STATUS.BLOCKED).toBe(403);
    expect(ERROR_HTTP_STATUS.USER_UNAVAILABLE).toBe(404);
  });

  it("canonicalizes participant pair deterministically and rejects self-pairs or colons", () => {
    const ab = canonicalConversationPair("user-a", "user-b");
    const ba = canonicalConversationPair("user-b", "user-a");
    expect(ab).toEqual(ba);
    expect(ab).toEqual({
      pairKey: "user-a:user-b",
      participantIds: ["user-a", "user-b"],
    });

    expect(() => canonicalConversationPair("user-a", "user-a")).toThrow();
    expect(() => canonicalConversationPair("user:a", "user-b")).toThrow();
  });

  it("validates create request allowlist strictly and rejects third-participant overrides", () => {
    expect(
      validateCreateConversationRequest({
        schemaVersion: 1,
        peerUserId: "user-b",
      }),
    ).toEqual({
      ok: true,
      value: { schemaVersion: 1, peerUserId: "user-b" },
    });

    const withParticipants = validateCreateConversationRequest({
      schemaVersion: 1,
      peerUserId: "user-b",
      participantIds: ["user-a", "user-b", "user-c"],
    });
    expect(withParticipants).toMatchObject({ ok: false, code: "INVALID_REQUEST" });

    const withUnknown = validateCreateConversationRequest({
      schemaVersion: 1,
      peerUserId: "user-b",
      userId: "user-c",
    });
    expect(withUnknown).toMatchObject({ ok: false, code: "INVALID_REQUEST" });

    const withColon = validateCreateConversationRequest({
      schemaVersion: 1,
      peerUserId: "user:b",
    });
    expect(withColon).toMatchObject({ ok: false, code: "INVALID_REQUEST" });

    const badVersion = validateCreateConversationRequest({
      schemaVersion: 2,
      peerUserId: "user-b",
    });
    expect(badVersion).toMatchObject({ ok: false, code: "UNSUPPORTED_SCHEMA_VERSION" });
  });

  it("encodes/decodes cursors and bounds conversation list query", () => {
    const cursor = encodeConversationCursor("2026-01-02T03:04:05.000Z", "conv_123");
    const decoded = decodeConversationCursor(cursor);
    expect(decoded).toEqual({
      ok: true,
      value: { v: 1, lastActivityAt: "2026-01-02T03:04:05.000Z", id: "conv_123" },
    });

    expect(decodeConversationCursor("not@@valid")).toMatchObject({
      ok: false,
      code: "INVALID_CURSOR",
    });

    const badVersionCursor = globalThis
      .btoa(JSON.stringify({ v: 2, lastActivityAt: "2026-01-02T03:04:05.000Z", id: "conv_1" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(decodeConversationCursor(badVersionCursor)).toMatchObject({
      ok: false,
      code: "INVALID_CURSOR",
    });

    const badIdCursor = globalThis
      .btoa(JSON.stringify({ v: 1, lastActivityAt: "2026-01-02T03:04:05.000Z", id: "conv:1" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(decodeConversationCursor(badIdCursor)).toMatchObject({
      ok: false,
      code: "INVALID_CURSOR",
    });

    expect(validateConversationListQuery({})).toEqual({
      ok: true,
      value: { limit: 50, before: null },
    });
    expect(validateConversationListQuery({ limit: "100", before: cursor })).toEqual({
      ok: true,
      value: {
        limit: 100,
        before: { v: 1, lastActivityAt: "2026-01-02T03:04:05.000Z", id: "conv_123" },
      },
    });
    expect(validateConversationListQuery({ limit: "101" })).toMatchObject({
      ok: false,
      code: "INVALID_REQUEST",
    });
    expect(validateConversationListQuery({ limit: "10", extra: "1" })).toMatchObject({
      ok: false,
      code: "INVALID_REQUEST",
    });
  });

  it("enforces strict PUBLIC_FIELDS and 2-participant invariants on response validators", () => {
    const validSummary = {
      id: "conv_1",
      schemaVersion: 1,
      participantIds: ["user-a", "user-b"],
      peer: {
        userId: "user-b",
        username: "bob",
        displayName: "Bob",
        avatar: null,
      },
      lastSeq: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      blockedByViewer: false,
    };

    expect(hasOnlyFields(validSummary, PUBLIC_FIELDS.conversationSummary)).toBe(true);
    expect(hasOnlyFields(validSummary.peer, PUBLIC_FIELDS.conversationPeer)).toBe(true);
    expect(validateConversationSummary(validSummary).ok).toBe(true);
    expect(
      validateConversationCreateResponse({ conversation: validSummary, created: true }).ok,
    ).toBe(true);
    expect(validateConversationDetailResponse({ conversation: validSummary }).ok).toBe(true);
    expect(
      validateConversationListResponse({ items: [validSummary], nextCursor: null, hasMore: false })
        .ok,
    ).toBe(true);

    expect(
      validateConversationSummary({
        ...validSummary,
        participantIds: ["user-a", "user-b", "user-c"],
      }),
    ).toMatchObject({ ok: false, code: "INVALID_REQUEST" });

    expect(
      validateConversationSummary({
        ...validSummary,
        participantIds: ["user-b", "user-b"],
      }),
    ).toMatchObject({ ok: false, code: "INVALID_REQUEST" });

    expect(
      validateConversationSummary({
        ...validSummary,
        peer: { ...validSummary.peer, userId: "user-c" },
      }),
    ).toMatchObject({ ok: false, code: "INVALID_REQUEST" });

    for (const forbiddenField of CONVERSATION_FORBIDDEN_FIELDS) {
      expect(
        validateConversationSummary({
          ...validSummary,
          [forbiddenField]: "leak",
        }),
      ).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    }
  });
});

describe("P2-03 MemoryConversationStore & MongoConversationStore", () => {
  it("serializes concurrent reverse-order upserts to a single canonical conversation", async () => {
    let releaseHook: (() => void) | null = null;
    const hookEntered = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    let idCounter = 0;
    const store = new MemoryConversationStore({
      idGenerator: () => `conv_${++idCounter}`,
      beforeInsertHook: async () => {
        releaseHook?.();
        await gate;
      },
    });

    const p1 = store.upsertDirect("user-b", "user-a", new Date("2026-01-01T00:00:00.000Z"));
    const p2 = store.upsertDirect("user-a", "user-b", new Date("2026-01-01T00:00:01.000Z"));

    await hookEntered;
    releaseGate();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r1.conversation.id).toBe("conv_1");
    expect(r2.conversation.id).toBe("conv_1");
    expect(r1.conversation.participantIds).toEqual(["user-a", "user-b"]);
    expect(r1.conversation.pairKey).toBe("user-a:user-b");
  });

  it("paginates MemoryConversationStore deterministically across timestamp and id ties", async () => {
    const store = new MemoryConversationStore({
      idGenerator: (() => {
        const ids = ["conv_a", "conv_c", "conv_b", "conv_d"];
        return () => ids.shift()!;
      })(),
    });

    await store.upsertDirect("user-a", "user-1", new Date("2026-01-01T10:00:00.000Z")); // conv_a (tie t1)
    await store.upsertDirect("user-a", "user-2", new Date("2026-01-01T10:00:00.000Z")); // conv_c (tie t1)
    await store.upsertDirect("user-a", "user-3", new Date("2026-01-01T11:00:00.000Z")); // conv_b (newer t2)
    await store.upsertDirect("user-a", "user-4", new Date("2026-01-01T09:00:00.000Z")); // conv_d (older t0)

    const page1 = await store.listForUser("user-a", { limit: 2, before: null });
    expect(page1.hasMore).toBe(true);
    expect(page1.items.map((c) => c.id)).toEqual(["conv_b", "conv_c"]);
    expect(page1.nextCursor).not.toBeNull();

    const before1 = decodeConversationCursor(page1.nextCursor!);
    expect(before1.ok).toBe(true);
    if (!before1.ok) throw new Error("unexpected");

    const page2 = await store.listForUser("user-a", { limit: 2, before: before1.value });
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
    expect(page2.items.map((c) => c.id)).toEqual(["conv_a", "conv_d"]);
  });

  it("handles atomic upsert, E11000/11000 duplicate read-back, corrupt-doc guard, and pagination in MongoConversationStore", async () => {
    const mock = createMockMongoCollection();
    const store = new MongoConversationStore(mock.collection, {
      idGenerator: () => "conv_mongo_1",
    });

    const first = await store.upsertDirect(
      "user-b",
      "user-a",
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(first.created).toBe(true);
    expect(first.conversation.participantIds).toEqual(["user-a", "user-b"]);

    const second = await store.upsertDirect("user-a", "user-b");
    expect(second.created).toBe(false);
    expect(second.conversation.id).toBe("conv_mongo_1");

    mock.simulateNextDuplicateCode(11000);
    const race11000 = await store.upsertDirect("user-c", "user-d");
    expect(race11000.created).toBe(false);
    expect(race11000.conversation.id).toBe("conv_concurrent_winner");

    mock.simulateNextDuplicateCode("E11000_MSG");
    const raceMsg = await store.upsertDirect("user-e", "user-f");
    expect(raceMsg.created).toBe(false);
    expect(raceMsg.conversation.participantIds).toEqual(["user-e", "user-f"]);

    // Rejects corrupted 3-participant DB documents on read.
    mock.injectCorruptDoc({
      _id: "conv_corrupt",
      pairKey: "user-x:user-y",
      participantIds: ["user-x", "user-y", "user-z"],
      lastSeq: 0,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
      schemaVersion: 1,
    });
    await expect(store.getById("conv_corrupt")).rejects.toThrow();

    // Cursor listing on MongoConversationStore handles (lastActivityAt desc, _id desc) ties cleanly.
    const ids = ["conv_m1", "conv_m2", "conv_m3"];
    const pagedStore = new MongoConversationStore(createMockMongoCollection().collection, {
      idGenerator: () => ids.shift()!,
    });
    await pagedStore.upsertDirect("user-p", "user-1", new Date("2026-01-02T00:00:00.000Z"));
    await pagedStore.upsertDirect("user-p", "user-2", new Date("2026-01-02T00:00:00.000Z"));
    await pagedStore.upsertDirect("user-p", "user-3", new Date("2026-01-01T00:00:00.000Z"));

    const mPage1 = await pagedStore.listForUser("user-p", { limit: 2, before: null });
    expect(mPage1.hasMore).toBe(true);
    expect(mPage1.items.map((c) => c.id)).toEqual(["conv_m2", "conv_m1"]);
    const mCursor = decodeConversationCursor(mPage1.nextCursor!);
    expect(mCursor.ok).toBe(true);
    if (!mCursor.ok) throw new Error("unexpected");
    const mPage2 = await pagedStore.listForUser("user-p", { limit: 2, before: mCursor.value });
    expect(mPage2.hasMore).toBe(false);
    expect(mPage2.items.map((c) => c.id)).toEqual(["conv_m3"]);
  });
});

describe("P2-03 ConversationRateLimiter (10/hour, 50/day)", () => {
  it("enforces hourly and daily caps and reports positive Retry-After", () => {
    const limiter = new ConversationRateLimiter();
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");

    for (let i = 0; i < 10; i++) {
      expect(limiter.consume("user-a", new Date(t0 + i * 1000))).toEqual({ allowed: true });
    }
    const hourBlocked = limiter.consume("user-a", new Date(t0 + 10_000));
    expect(hourBlocked).toMatchObject({ allowed: false, limitScope: "hour" });
    if (!hourBlocked.allowed) {
      expect(hourBlocked.retryAfterSeconds).toBe(3590);
    }

    // Other users remain isolated.
    expect(limiter.consume("user-b", new Date(t0 + 10_000))).toEqual({ allowed: true });

    // Once > 1h has elapsed, fill up to 50/day across 4 additional 2h windows.
    for (let batch = 1; batch <= 4; batch++) {
      const batchStart = t0 + batch * 2 * 60 * 60 * 1000;
      for (let i = 0; i < 10; i++) {
        expect(limiter.consume("user-a", new Date(batchStart + i * 1000))).toEqual({
          allowed: true,
        });
      }
    }

    const after50 = t0 + 9 * 60 * 60 * 1000;
    const dayBlocked = limiter.consume("user-a", new Date(after50));
    expect(dayBlocked).toMatchObject({ allowed: false, limitScope: "day" });
    if (!dayBlocked.allowed) {
      expect(dayBlocked.retryAfterSeconds).toBe(15 * 60 * 60);
    }

    // After 24h from t0, the earliest slots expire.
    expect(limiter.consume("user-a", new Date(t0 + 24 * 60 * 60 * 1000 + 1000))).toEqual({
      allowed: true,
    });
  });
});

describe("P2-03 Web ConversationsClient & state mappers", () => {
  it("sends Bearer auth with credentials: omit and validates responses strictly", async () => {
    const seenRequests: Array<{ url: string; init: RequestInit }> = [];
    const client = new ConversationsClient({
      apiOrigin: "https://api.example.test",
      expectedUserId: "user-a",
      getToken: () => "jwt-token-a",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        seenRequests.push({ url: String(input), init: init ?? {} });
        return new Response(
          JSON.stringify({
            ok: true,
            requestId: "req-1",
            data: {
              conversation: {
                id: "conv_1",
                schemaVersion: 1,
                participantIds: ["user-a", "user-b"],
                peer: { userId: "user-b", username: "bob", displayName: "Bob", avatar: null },
                lastSeq: 0,
                createdAt: "2026-01-01T00:00:00.000Z",
                lastActivityAt: "2026-01-01T00:00:00.000Z",
                blockedByViewer: false,
              },
              created: true,
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });

    const created = await client.createOrGet("user-b");
    expect(created.created).toBe(true);
    expect(seenRequests[0]!.url).toBe("https://api.example.test/api/v1/conversations");
    expect(seenRequests[0]!.init.credentials).toBe("omit");
    expect(seenRequests[0]!.init.headers).toMatchObject({
      authorization: "Bearer jwt-token-a",
      "content-type": "application/json",
    });

    // Rejects tampered 3-participant responses before surfacing to UI state.
    const badClient = new ConversationsClient({
      apiOrigin: "https://api.example.test",
      expectedUserId: "user-a",
      getToken: () => "jwt-token-a",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            ok: true,
            requestId: "req-2",
            data: {
              items: [
                {
                  id: "conv_bad",
                  schemaVersion: 1,
                  participantIds: ["user-a", "user-b", "user-c"],
                  peer: { userId: "user-b", username: "bob", displayName: "Bob", avatar: null },
                  lastSeq: 0,
                  createdAt: "2026-01-01T00:00:00.000Z",
                  lastActivityAt: "2026-01-01T00:00:00.000Z",
                  blockedByViewer: false,
                },
              ],
              nextCursor: null,
              hasMore: false,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });
    await expect(badClient.list()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    // Extracts Retry-After cleanly on 429 RATE_LIMITED.
    const limitedClient = new ConversationsClient({
      apiOrigin: "https://api.example.test",
      expectedUserId: "user-a",
      getToken: () => "jwt-token-a",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            ok: false,
            requestId: "req-3",
            error: {
              code: "RATE_LIMITED",
              message: "Slow down",
              retryable: true,
            },
          }),
          {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "42" },
          },
        )) as typeof fetch,
    });
    await expect(limitedClient.createOrGet("user-b")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfterSeconds: 42,
      retryable: true,
    });
  });

  it("maps error states, blockedByViewer compose state, stale-request guard, tombstone avatar, and error copy", () => {
    expect(
      mapConversationOpenError(new ConversationsApiError(404, "USER_UNAVAILABLE", false)),
    ).toMatchObject({ status: "unavailable", code: "USER_UNAVAILABLE" });
    expect(
      mapConversationOpenError(new ConversationsApiError(403, "BLOCKED", false)),
    ).toMatchObject({ status: "unavailable", code: "BLOCKED" });
    expect(
      mapConversationListError(new ConversationsApiError(403, "FORBIDDEN", false)),
    ).toMatchObject({ status: "forbidden", code: "FORBIDDEN" });
    expect(
      mapConversationListError(new ConversationsApiError(401, "SESSION_REVOKED", false)),
    ).toMatchObject({ status: "unauthenticated", code: "SESSION_REVOKED" });
    expect(
      mapConversationListError(new ConversationsApiError(429, "RATE_LIMITED", true, "req-1", 15)),
    ).toMatchObject({
      status: "error",
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterSeconds: 15,
    });

    const baseSummary = {
      id: "conv_1",
      schemaVersion: 1 as const,
      participantIds: ["user-a", "user-b"] as [string, string],
      peer: { userId: "user-b", username: null, displayName: null, avatar: null },
      lastSeq: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      blockedByViewer: true,
    };
    expect(toConversationOpenReadyState(baseSummary, false)).toMatchObject({
      status: "ready",
      composeAllowed: false,
      noticeKey: "conversations.blockedByYouNotice",
    });
    expect(
      toConversationOpenReadyState({ ...baseSummary, blockedByViewer: false }, true),
    ).toMatchObject({
      status: "ready",
      created: true,
      composeAllowed: true,
      noticeKey: null,
    });

    const guard = createRequestVersionGuard();
    const v1 = guard.begin("user-a");
    const v2 = guard.begin("user-a");
    expect(guard.isCurrent("user-a", v1)).toBe(false);
    expect(guard.isCurrent("user-a", v2)).toBe(true);
    guard.invalidate();
    expect(guard.isCurrent("user-a", v2)).toBe(false);

    expect(CONVERSATION_TOMBSTONE_LABEL_KEY).toBe("conversations.tombstoneUser");
    expect(peerAvatarDescriptor(baseSummary.peer)).toBeTruthy();

    const unavailableCopy = errorCopyFor("USER_UNAVAILABLE");
    const blockedCopy = errorCopyFor("BLOCKED");
    expect(unavailableCopy).not.toEqual(blockedCopy);
    expect(JSON.stringify(unavailableCopy).toLowerCase()).not.toContain("block");
  });
});
