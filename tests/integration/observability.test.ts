import type { Server } from "node:http";

import * as jose from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../apps/api/src/app.js";
import { createVerifier, mintTestToken } from "../../apps/api/src/auth/jwt.js";
import { clearSessionCache } from "../../apps/api/src/auth/session.js";
import { MetricsRegistry } from "../../apps/api/src/observability/index.js";

const ISS = "http://127.0.0.1:3000";
const AUD = "http://127.0.0.1:3001";

let server: Server;
let baseUrl: string;
let tokenUser: string;
let tokenOperator: string;
const metrics = new MetricsRegistry();

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
  tokenUser = (
    await mintTestToken({
      sub: "user-a",
      sid: "sid-a",
      emailVerified: true,
      iss: ISS,
      aud: AUD,
      keyPair: shared,
    })
  ).token;
  tokenOperator = (
    await mintTestToken({
      sub: "op-1",
      sid: "sid-op",
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
    metrics,
    roleLookup: async (userId) => (userId === "op-1" ? "operator" : "user"),
    sessionLookup: async (sid: string) => {
      if (sid === "sid-a")
        return { sid, userId: "user-a", revoked: false, authenticatedAt: new Date() };
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

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

type EnvelopeBody = {
  ok: boolean;
  requestId: string;
  data?: Record<string, unknown>;
  error?: { code: string };
};

describe("P1-12 — correlation IDs and metrics surface", () => {
  it("echoes a valid client X-Request-Id and generates one otherwise", async () => {
    const uuid = "11111111-1111-4111-8111-111111111111";
    const withId = await fetch(`${baseUrl}/health`, {
      headers: { "x-request-id": uuid },
    });
    expect(withId.headers.get("x-request-id")).toBe(uuid);

    const withoutId = await fetch(`${baseUrl}/health`);
    const generated = withoutId.headers.get("x-request-id");
    expect(generated).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("propagates the correlation ID into error envelopes", async () => {
    const uuid = "11111111-1111-4111-8111-111111111111";
    const res = await fetch(`${baseUrl}/api/v1/does-not-exist`, {
      headers: { "x-request-id": uuid, ...authHeaders(tokenUser) },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as EnvelopeBody;
    expect(body.requestId).toBe(uuid);
  });

  it("serves metrics to operators only, with no content labels", async () => {
    const user = await fetch(`${baseUrl}/api/v1/metrics`, { headers: authHeaders(tokenUser) });
    expect(user.status).toBe(403);

    const unauthenticated = await fetch(`${baseUrl}/api/v1/metrics`);
    expect(unauthenticated.status).toBe(401);

    const operator = await fetch(`${baseUrl}/api/v1/metrics`, {
      headers: authHeaders(tokenOperator),
    });
    expect(operator.status).toBe(200);
    const body = (await operator.json()) as EnvelopeBody;
    expect(body.ok).toBe(true);
    const counters = body.data as unknown as { counters: Record<string, number> };
    expect(counters.counters).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("user-a");
    expect(JSON.stringify(body)).not.toContain("op-1");
  });

  it("recording metrics never leaks synthetic markers into snapshots", async () => {
    metrics.inc("http_requests_total", {
      component: "http",
      method: "GET",
      statusClass: "2xx",
    });
    const snapshot = metrics.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain("SYNTHETIC");
  });
});
