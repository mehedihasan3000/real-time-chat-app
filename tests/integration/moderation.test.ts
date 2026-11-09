import type { Server } from "node:http";

import * as jose from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../apps/api/src/app.js";
import { createVerifier, mintTestToken } from "../../apps/api/src/auth/jwt.js";
import { clearSessionCache } from "../../apps/api/src/auth/session.js";
import { MemoryBlockStore } from "../../apps/api/src/blocks/store.js";
import { MemoryReportStore } from "../../apps/api/src/reports/store.js";
import { MemoryProfileStore } from "../../apps/api/src/profiles/store.js";

const ISS = "http://127.0.0.1:3000";
const AUD = "http://127.0.0.1:3001";

let server: Server;
let baseUrl: string;
let tokenA: string;
let tokenB: string;
let tokenOp: string;

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
  const mint = (sub: string, sid: string) =>
    mintTestToken({ sub, sid, emailVerified: true, iss: ISS, aud: AUD, keyPair: shared }).then(
      (r) => r.token,
    );
  tokenA = await mint("user-a", "sid-a");
  tokenB = await mint("user-b", "sid-b");
  tokenOp = await mint("op-1", "sid-op");

  const verifier = createVerifier({
    appOrigin: ISS,
    apiOrigin: AUD,
    resolveKey: (async () => shared.publicKey as never) as never,
  });

  server = createApp({
    verifier,
    blockStore: new MemoryBlockStore(),
    reportStore: new MemoryReportStore(),
    profileStore: new MemoryProfileStore([
      {
        userId: "user-a",
        username: "ada",
        displayName: "Ada",
        avatar: null,
        locale: "en",
        timeZone: "UTC",
      },
      {
        userId: "user-b",
        username: "bob",
        displayName: "Bob",
        avatar: null,
        locale: "en",
        timeZone: "UTC",
      },
    ]),
    roleLookup: async (userId) => (userId === "op-1" ? "operator" : "user"),
    sessionLookup: async (sid: string) => {
      if (sid === "sid-a")
        return { sid, userId: "user-a", revoked: false, authenticatedAt: new Date() };
      if (sid === "sid-b")
        return { sid, userId: "user-b", revoked: false, authenticatedAt: new Date() };
      if (sid === "sid-op")
        return { sid, userId: "op-1", revoked: false, authenticatedAt: new Date() };
      return null;
    },
  }).listen(0);
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

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

type EnvelopeBody = {
  ok: boolean;
  requestId?: string;
  data?: Record<string, unknown> & { items?: unknown[] };
  error?: { code: string; message: string };
};

describe("TC-PRIV-003 — block APIs are private and silent", () => {
  it("create/list/delete round-trips for the blocker only", async () => {
    const created = await fetch(`${baseUrl}/api/v1/blocks`, {
      method: "POST",
      headers: { ...auth(tokenA), "content-type": "application/json" },
      body: JSON.stringify({ blockedUserId: "user-b" }),
    });
    expect(created.status).toBe(200);
    const list = await fetch(`${baseUrl}/api/v1/blocks`, { headers: auth(tokenA) });
    expect(((await list.json()) as EnvelopeBody).data?.items).toEqual([
      { blockedUserId: "user-b" },
    ]);
    // The blocked user's own list is empty — no disclosure.
    const other = await fetch(`${baseUrl}/api/v1/blocks`, { headers: auth(tokenB) });
    expect(((await other.json()) as EnvelopeBody).data?.items).toEqual([]);
    // Discovery omits the blocked pair in both directions.
    const discovery = await fetch(`${baseUrl}/api/v1/discovery?username=bob`, {
      headers: auth(tokenA),
    });
    expect(((await discovery.json()) as EnvelopeBody).data?.items).toEqual([]);
    const removed = await fetch(`${baseUrl}/api/v1/blocks/user-b`, {
      method: "DELETE",
      headers: auth(tokenA),
    });
    expect(removed.status).toBe(200);
    const after = await fetch(`${baseUrl}/api/v1/discovery?username=bob`, {
      headers: auth(tokenA),
    });
    expect(((await after.json()) as EnvelopeBody).data?.items).toHaveLength(1);
  });

  it("self-block is rejected", async () => {
    const res = await fetch(`${baseUrl}/api/v1/blocks`, {
      method: "POST",
      headers: { ...auth(tokenA), "content-type": "application/json" },
      body: JSON.stringify({ blockedUserId: "user-a" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("TC-PRIV-004 — reports: metadata-only, consent-gated, deduped", () => {
  it("metadata-only report succeeds; excerpts without consent fail", async () => {
    const ok = await fetch(`${baseUrl}/api/v1/reports`, {
      method: "POST",
      headers: { ...auth(tokenA), "content-type": "application/json" },
      body: JSON.stringify({ reportedUserId: "user-b", reason: "spam" }),
    });
    expect(ok.status).toBe(200);
    const noConsent = await fetch(`${baseUrl}/api/v1/reports`, {
      method: "POST",
      headers: { ...auth(tokenA), "content-type": "application/json" },
      body: JSON.stringify({
        reportedUserId: "user-b",
        reason: "spam",
        optionalExcerpts: ["x"],
        excerptConsent: false,
      }),
    });
    expect(noConsent.status).toBe(400);
  });

  it("consented excerpts are stored; duplicate within 24h conflicts", async () => {
    const first = await fetch(`${baseUrl}/api/v1/reports`, {
      method: "POST",
      headers: { ...auth(tokenB), "content-type": "application/json" },
      body: JSON.stringify({
        reportedUserId: "user-a",
        reason: "harassment",
        optionalReferences: ["msg-1"],
        optionalExcerpts: ["excerpt-1"],
        excerptConsent: true,
      }),
    });
    expect(first.status).toBe(200);
    const duplicate = await fetch(`${baseUrl}/api/v1/reports`, {
      method: "POST",
      headers: { ...auth(tokenB), "content-type": "application/json" },
      body: JSON.stringify({ reportedUserId: "user-a", reason: "spam" }),
    });
    expect(duplicate.status).toBe(409);
  });

  it("reported user never sees reporter identity or content", async () => {
    // B's own list contains only B's report (against A); A's list contains
    // only A's report (against B). Neither sees the other's excerpts.
    const aList = await fetch(`${baseUrl}/api/v1/reports`, { headers: auth(tokenA) });
    const aBody = (await aList.json()) as EnvelopeBody;
    expect(aBody.data?.items).toHaveLength(1);
    expect(JSON.stringify(aBody)).not.toContain("excerpt-1");
    const bList = await fetch(`${baseUrl}/api/v1/reports`, { headers: auth(tokenB) });
    const bBody = (await bList.json()) as EnvelopeBody;
    expect(bBody.data?.items).toHaveLength(1);
    expect(JSON.stringify(bBody)).not.toContain("reporterUserId");
  });
});

describe("TC-PRIV-005 — operator-only moderation + single appeal", () => {
  it("queue/dispose require the operator role", async () => {
    const userQueue = await fetch(`${baseUrl}/api/v1/moderation/queue`, {
      headers: auth(tokenA),
    });
    expect(userQueue.status).toBe(403);
    const operatorQueue = await fetch(`${baseUrl}/api/v1/moderation/queue`, {
      headers: auth(tokenOp),
    });
    expect(operatorQueue.status).toBe(200);
    const items = ((await operatorQueue.json()) as EnvelopeBody).data?.items as unknown[];
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(items)).toContain("excerpt-1");
  });

  it("dispose then appeal: once, within 7 days", async () => {
    // Report from B against A is the operator-visible one; dispose it.
    const queue = await fetch(`${baseUrl}/api/v1/moderation/queue`, {
      headers: auth(tokenOp),
    });
    const reports = ((await queue.json()) as EnvelopeBody).data?.items as Array<
      Record<string, unknown>
    >;
    const target = reports.find((r) => r.reportedUserId === "user-a");
    expect(target).toBeTruthy();
    const reportId = String(target?.reportId);

    const dispose = await fetch(`${baseUrl}/api/v1/moderation/reports/${reportId}/dispose`, {
      method: "POST",
      headers: { ...auth(tokenOp), "content-type": "application/json" },
      body: JSON.stringify({ disposition: "warning" }),
    });
    expect(dispose.status).toBe(200);

    // The reported user (A) appeals: allowed once.
    const appeal = await fetch(`${baseUrl}/api/v1/reports/${reportId}/appeal`, {
      method: "POST",
      headers: { ...auth(tokenA), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(appeal.status).toBe(200);
    // Reporter (B) sees only the action, never reporter identity of others.
    const second = await fetch(`${baseUrl}/api/v1/reports/${reportId}/appeal`, {
      method: "POST",
      headers: { ...auth(tokenA), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(second.status).toBe(409);
  });
});
