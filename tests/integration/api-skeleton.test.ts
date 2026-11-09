import type { Server } from "node:http";

import * as jose from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp, type CreateAppOptions } from "../../apps/api/src/app.js";
import { createVerifier, mintTestToken } from "../../apps/api/src/auth/jwt.js";
import { clearSessionCache } from "../../apps/api/src/auth/session.js";

const ISS = "http://127.0.0.1:3000";
const AUD = "http://127.0.0.1:3001";

let server: Server;
let baseUrl: string;
let tokenA: string;
let tokenB: string;
let tokenUnverified: string;

const conversationStore = new Map<string, { id: string; participantIds: string[] }>([
  ["conv-ab", { id: "conv-ab", participantIds: ["user-a", "user-b"] }],
  ["conv-cd", { id: "conv-cd", participantIds: ["user-c", "user-d"] }],
]);

beforeAll(async () => {
  clearSessionCache();
  const keyPair = (await jose.generateKeyPair("Ed25519", {
    extractable: true,
  })) as unknown as {
    privateKey: import("jose").CryptoKey;
    publicKey: import("jose").CryptoKey;
    kid: string;
  };
  const shared = { ...keyPair, kid: "test-kid" };
  tokenA = (
    await mintTestToken({
      sub: "user-a",
      sid: "sid-a",
      emailVerified: true,
      iss: ISS,
      aud: AUD,
      keyPair: shared,
    })
  ).token;
  tokenB = (
    await mintTestToken({
      sub: "user-b",
      sid: "sid-b",
      emailVerified: true,
      iss: ISS,
      aud: AUD,
      keyPair: shared,
    })
  ).token;
  tokenUnverified = (
    await mintTestToken({
      sub: "user-u",
      sid: "sid-u",
      emailVerified: false,
      iss: ISS,
      aud: AUD,
      keyPair: shared,
    })
  ).token;

  const verifier = createVerifier({
    appOrigin: ISS,
    apiOrigin: AUD,
    resolveKey: (async () => shared.publicKey as never) as never,
  });

  const options: CreateAppOptions = {
    verifier,
    sessionLookup: async (sid: string) => {
      if (sid === "sid-a")
        return { sid, userId: "user-a", revoked: false, authenticatedAt: new Date() };
      if (sid === "sid-b")
        return { sid, userId: "user-b", revoked: false, authenticatedAt: new Date() };
      if (sid === "sid-u")
        return { sid, userId: "user-u", revoked: false, authenticatedAt: new Date() };
      return null;
    },
    conversationLookup: async (id: string) => conversationStore.get(id) ?? null,
  };

  server = createApp(options).listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected ephemeral port.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function req(path: string, token?: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

type EnvelopeBody = {
  ok: boolean;
  requestId: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
};

describe("P1-08 — routes return documented schemas and safe errors", () => {
  it("GET /health stays public; /api/v1/me requires auth and returns documented fields only", async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);

    const unauthenticated = await req("/api/v1/me");
    expect(unauthenticated.status).toBe(401);
    const unauthBody = (await unauthenticated.json()) as EnvelopeBody;
    expect(unauthBody.error?.code).toBe("UNAUTHENTICATED");

    const me = await req("/api/v1/me", tokenA);
    expect(me.status).toBe(200);
    const body = (await me.json()) as EnvelopeBody;
    expect(body.ok).toBe(true);
    expect(body.requestId).toBeTruthy();
    expect(Object.keys(body.data ?? {}).sort()).toEqual(
      ["emailVerified", "role", "sessionFresh", "userId"].sort(),
    );
    expect(body.data?.userId).toBe("user-a");
    expect(JSON.stringify(body.data)).not.toContain("sid");
  });

  it("GET /api/me alias returns the same principal-derived shape", async () => {
    const res = await req("/api/me", tokenA);
    expect(res.status).toBe(200);
    const body = (await res.json()) as EnvelopeBody;
    expect(body.data?.userId).toBe("user-a");
  });

  it("GET /api/v1/ready is public and leaks no topology", async () => {
    const res = await fetch(`${baseUrl}/api/v1/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as EnvelopeBody;
    expect(body.data).toEqual({ ready: true, service: "api" });
    expect(JSON.stringify(body)).not.toContain("mongodb");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("unknown routes return a safe 404 envelope", async () => {
    const res = await req("/api/v1/does-not-exist", tokenA);
    expect(res.status).toBe(404);
    const body = (await res.json()) as EnvelopeBody;
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("NOT_FOUND");
  });
});

describe("P1-08 — discovery exact-only, neutral no-result", () => {
  it("rejects prefix/email-style and malformed usernames with INVALID_REQUEST", async () => {
    for (const path of [
      "/api/v1/discovery?username=ab",
      "/api/v1/discovery?username=Al",
      "/api/v1/discovery?username=admin",
      "/api/v1/discovery?email=a@example.com",
    ]) {
      const res = await req(path, tokenA);
      expect(res.status).toBe(400);
    }
  });

  it("returns neutral empty for a valid exact username (blocked omitted, no leak)", async () => {
    const res = await req("/api/v1/discovery?username=alice", tokenA);
    expect(res.status).toBe(200);
    const body = (await res.json()) as EnvelopeBody;
    expect(body.data).toEqual({ items: [] });
  });
});

describe("P1-08 — conversations/history are member-only and bounded", () => {
  it("lists only own (empty placeholder); nonparticipant history gets uniform 404", async () => {
    const list = await req("/api/v1/conversations", tokenA);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as EnvelopeBody;
    expect(listBody.data).toEqual({ items: [], nextCursor: null, hasMore: false });

    const memberHistory = await req("/api/v1/conversations/conv-ab/messages", tokenA);
    expect(memberHistory.status).toBe(200);
    const memberBody = (await memberHistory.json()) as EnvelopeBody;
    expect(memberBody.data).toEqual({ items: [], nextCursor: null, hasMore: false });

    // tokenB is a member of conv-ab and conv-cd is not.
    const stranger = await req("/api/v1/conversations/conv-cd/messages", tokenB);
    expect(stranger.status).toBe(404);
    const strangerBody = (await stranger.json()) as EnvelopeBody;
    expect(strangerBody.error?.code).toBe("NOT_FOUND");
    // Missing conversation is indistinguishable (same code/message shape).
    const missing = await req("/api/v1/conversations/conv-nope/messages", tokenA);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as EnvelopeBody).error?.code).toBe("NOT_FOUND");
  });

  it("enforces history pagination bounds and cursor validation", async () => {
    const tooLarge = await req("/api/v1/conversations/conv-ab/messages?limit=101", tokenA);
    expect(tooLarge.status).toBe(400);
    const badCursor = await req("/api/v1/conversations/conv-ab/messages?before=@@bad", tokenA);
    expect(badCursor.status).toBe(400);
  });

  it("POST /conversations placeholder does not mutate (503)", async () => {
    const res = await req("/api/v1/conversations", tokenA, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1 }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as EnvelopeBody;
    expect(body.error?.code).toBe("TEMPORARILY_UNAVAILABLE");
  });
});

describe("P1-08 — block/report/appeal placeholders cannot leak or mutate", () => {
  it("own block/report lists are empty; create/appeal are 503 without mutation", async () => {
    const blocks = await req("/api/v1/blocks", tokenA);
    expect(blocks.status).toBe(200);
    expect(((await blocks.json()) as EnvelopeBody).data).toEqual({ items: [] });

    const createBlock = await req("/api/v1/blocks", tokenA, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blockedUserId: "user-b" }),
    });
    expect(createBlock.status).toBe(503);

    // The second user sees the same empty list — no cross-user disclosure.
    const otherBlocks = await req("/api/v1/blocks", tokenB);
    expect(((await otherBlocks.json()) as EnvelopeBody).data).toEqual({ items: [] });

    const reports = await req("/api/v1/reports", tokenA);
    expect(reports.status).toBe(200);

    const appeal = await req("/api/v1/reports/rep-1/appeal", tokenA, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(appeal.status).toBe(503);
  });

  it("reports reject excerpts and bad reasons (metadata-only)", async () => {
    const withExcerpts = await req("/api/v1/reports", tokenA, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "spam", optionalExcerpts: ["x"] }),
    });
    expect(withExcerpts.status).toBe(400);

    const badReason = await req("/api/v1/reports", tokenA, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "not-a-reason" }),
    });
    expect(badReason.status).toBe(400);
  });
});

describe("P1-08 — calls/devices/backups/AI placeholders stay owner-scoped", () => {
  it("owner-only single-resource reads return 404 for strangers", async () => {
    for (const path of [
      "/api/v1/calls/call-1",
      "/api/v1/devices/dev-1/keys",
      "/api/v1/key-backups/bak-1",
    ]) {
      const stranger = await req(path, tokenB);
      // v0 lookups are empty (fail-closed) → uniform 404 without disclosure.
      expect(stranger.status).toBe(404);
    }
  });

  it("AI placeholders return documented 503 and never persist plaintext", async () => {
    for (const feature of ["smart-reply", "translation", "summary"]) {
      const res = await req(`/api/v1/ai/${feature}`, tokenA, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, text: "synthetic" }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as EnvelopeBody;
      expect(body.error?.code).toBe("TEMPORARILY_UNAVAILABLE");
      expect(JSON.stringify(body)).not.toContain("synthetic");
    }
  });

  it("unverified principals are blocked from protected features", async () => {
    const res = await req("/api/v1/conversations", tokenUnverified);
    // guardProtected maps unverified → 403 FORBIDDEN.
    expect(res.status).toBe(403);
  });

  it("oversized bodies are rejected with PAYLOAD_TOO_LARGE", async () => {
    const huge = "a".repeat(40 * 1024);
    const res = await req("/api/v1/blocks", tokenA, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blockedUserId: huge }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as EnvelopeBody;
    expect(body.error?.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("malformed JSON is rejected with INVALID_REQUEST", async () => {
    const res = await req("/api/v1/blocks", tokenA, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as EnvelopeBody;
    expect(body.error?.code).toBe("INVALID_REQUEST");
  });

  it("default app (no verifier wired) fails closed on protected routes", async () => {
    const defaultServer = createApp().listen(0);
    await new Promise<void>((resolve, reject) => {
      defaultServer.once("listening", resolve);
      defaultServer.once("error", reject);
    });
    const address = defaultServer.address();
    if (!address || typeof address === "string") throw new Error("Expected ephemeral port.");
    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/api/v1/me`, {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => {
        defaultServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
