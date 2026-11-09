import type { Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../apps/api/src/app.js";
import { createVerifier, mintTestToken } from "../../apps/api/src/auth/jwt.js";
import { clearSessionCache } from "../../apps/api/src/auth/session.js";
import * as jose from "jose";

const ISS = "http://127.0.0.1:3000";
const AUD = "http://127.0.0.1:3001";

let server: Server;
let baseUrl: string;
let tokenA: string;

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

  const verifier = createVerifier({
    appOrigin: ISS,
    apiOrigin: AUD,
    resolveKey: (async () => shared.publicKey as never) as never,
  });

  server = createApp({
    verifier,
    sessionLookup: async (sid: string) =>
      sid === "sid-a"
        ? { sid, userId: "user-a", revoked: false, authenticatedAt: new Date() }
        : null,
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

describe("P1-13 — API security headers on every response", () => {
  it("ships nosniff/framing/referrer/permissions/HSTS headers", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toContain("strict-origin");
    expect(res.headers.get("permissions-policy")).toContain("camera=()");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("protected error responses carry the same headers + correlation ID", async () => {
    const res = await fetch(`${baseUrl}/api/v1/me`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});

describe("P1-13 — hostile input cannot inject, pollute, or escalate", () => {
  it("operator injection in discovery is rejected (no query leak)", async () => {
    const injected = await fetch(`${baseUrl}/api/v1/discovery?username[$ne]=null`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    // Validation treats the extended query as invalid (400), never as a query.
    expect(injected.status).toBe(400);
  });

  it("mass-assignment role field is ignored (never reflected or honored)", async () => {
    const created = await fetch(`${baseUrl}/api/v1/reports`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ reason: "spam", role: "operator", operator: true }),
    });
    // Placeholder 503 with a safe envelope; role/operator never echoed.
    expect(created.status).toBe(503);
    const body = (await created.json()) as { error?: { code: string } };
    expect(body.error?.code).toBe("TEMPORARILY_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toContain("operator");
  });

  it("prototype-pollution body keys do not pollute Object.prototype", async () => {
    const res = await fetch(`${baseUrl}/api/v1/blocks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenA}`,
        "content-type": "application/json",
      },
      body: '{"__proto__":{"polluted":"yes"},"blockedUserId":"user-b"}',
    });
    expect(res.status).toBe(503);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
