import type { Server } from "node:http";

import * as jose from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../apps/api/src/app.js";
import { createVerifier, mintTestToken } from "../../apps/api/src/auth/jwt.js";
import { clearSessionCache } from "../../apps/api/src/auth/session.js";
import { MemoryProfileStore } from "../../apps/api/src/profiles/store.js";

const ISS = "http://127.0.0.1:3000";
const AUD = "http://127.0.0.1:3001";

let server: Server;
let baseUrl: string;
let tokenA: string;
let tokenB: string;

const store = new MemoryProfileStore([
  {
    userId: "user-a",
    username: "ada",
    displayName: "Ada Lovelace",
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
  {
    userId: "user-c",
    username: "cara",
    displayName: "Cara",
    avatar: null,
    locale: "en",
    timeZone: "UTC",
  },
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

  const verifier = createVerifier({
    appOrigin: ISS,
    apiOrigin: AUD,
    resolveKey: (async () => shared.publicKey as never) as never,
  });

  server = createApp({
    verifier,
    profileStore: store,
    // user-b blocks user-c: discovery from B must omit C.
    isBlocked: async (a: string, b: string) =>
      (a === "user-b" && b === "user-c") || (a === "user-c" && b === "user-b"),
    sessionLookup: async (sid: string) => {
      if (sid === "sid-a")
        return { sid, userId: "user-a", revoked: false, authenticatedAt: new Date() };
      if (sid === "sid-b")
        return { sid, userId: "user-b", revoked: false, authenticatedAt: new Date() };
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
  data?: Record<string, unknown> & { items?: unknown[] };
  error?: { code: string };
};

describe("TC-PROF-001 — own display name updates one profile only", () => {
  it("GET /profiles/me returns the principal's own profile only", async () => {
    const res = await fetch(`${baseUrl}/api/v1/profiles/me`, { headers: auth(tokenA) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EnvelopeBody;
    expect(body.data?.userId).toBe("user-a");
    expect(body.data?.username).toBe("ada");
    expect(body.data?.avatar).toBeNull();
    expect(JSON.stringify(body)).not.toContain("email");
  });

  it("PATCH affects only the authenticated profile", async () => {
    const res = await fetch(`${baseUrl}/api/v1/profiles/me`, {
      method: "PATCH",
      headers: { ...auth(tokenA), "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Ada L." }),
    });
    expect(res.status).toBe(200);
    const me = await fetch(`${baseUrl}/api/v1/profiles/me`, { headers: auth(tokenA) });
    expect(((await me.json()) as EnvelopeBody).data?.displayName).toBe("Ada L.");
    const other = await fetch(`${baseUrl}/api/v1/profiles/me`, { headers: auth(tokenB) });
    expect(((await other.json()) as EnvelopeBody).data?.displayName).toBe("Bob");
  });

  it("rejects out-of-range display names", async () => {
    const res = await fetch(`${baseUrl}/api/v1/profiles/me`, {
      method: "PATCH",
      headers: { ...auth(tokenA), "content-type": "application/json" },
      body: JSON.stringify({ displayName: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("TC-PROF-001 — conflicting normalized usernames are rejected", () => {
  it("POST /profiles/username rejects case variants and reserved names", async () => {
    const conflict = await fetch(`${baseUrl}/api/v1/profiles/username`, {
      method: "POST",
      headers: { ...auth(tokenB), "content-type": "application/json" },
      body: JSON.stringify({ username: "ADA" }),
    });
    expect(conflict.status).toBe(409);
    for (const username of ["admin", "1bad"]) {
      const res = await fetch(`${baseUrl}/api/v1/profiles/username`, {
        method: "POST",
        headers: { ...auth(tokenB), "content-type": "application/json" },
        body: JSON.stringify({ username }),
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("TC-PROF-003 — exact discovery with privacy-safe fields", () => {
  it("returns the exact match with minimal fields only", async () => {
    const res = await fetch(`${baseUrl}/api/v1/discovery?username=bob`, {
      headers: auth(tokenA),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EnvelopeBody;
    const items = body.data?.items as Array<Record<string, unknown>> | undefined;
    expect(items).toHaveLength(1);
    const item = items?.[0] as Record<string, unknown>;
    expect(Object.keys(item).sort()).toEqual(
      ["avatar", "displayName", "userId", "username"].sort(),
    );
    expect(item.avatar).toBeNull();
    expect(JSON.stringify(body)).not.toContain("email");
    expect(JSON.stringify(body)).not.toContain("presence");
  });

  it("omits blocked users in either direction (neutral no-result)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/discovery?username=cara`, {
      headers: auth(tokenB),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as EnvelopeBody).data?.items).toEqual([]);
  });

  it("rejects prefix/email-style queries and hides nonexistent users neutrally", async () => {
    const prefix = await fetch(`${baseUrl}/api/v1/discovery?username=bo`, {
      headers: auth(tokenA),
    });
    expect(prefix.status).toBe(400);
    const missing = await fetch(`${baseUrl}/api/v1/discovery?username=missing_user`, {
      headers: auth(tokenA),
    });
    expect(missing.status).toBe(200);
    expect(((await missing.json()) as EnvelopeBody).data?.items).toEqual([]);
  });
});
