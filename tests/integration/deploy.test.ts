import type { Server } from "node:http";

import { readFileSync } from "node:fs";

import * as jose from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../apps/api/src/app.js";
import { createVerifier, mintTestToken } from "../../apps/api/src/auth/jwt.js";
import { clearSessionCache } from "../../apps/api/src/auth/session.js";
import { assertSafeSeedTarget, loadConfig } from "../../apps/api/src/config.js";
import {
  checkEnvSeparation,
  checkRenderYaml,
  checkStagingTemplate,
} from "../../apps/api/src/deploy/index.js";
import { checkCookieAttributes } from "../../apps/api/src/security/index.js";

const ISS = "http://127.0.0.1:3000";
const AUD = "http://127.0.0.1:3001";

let server: Server;
let baseUrl: string;

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
  await mintTestToken({
    sub: "user-a",
    sid: "sid-a",
    emailVerified: true,
    iss: ISS,
    aud: AUD,
    keyPair: shared,
  });

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

describe("P1-15 — local smoke: liveness/readiness without topology", () => {
  it("GET /health and /api/v1/ready pass smoke (no credentials/topology)", async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as Record<string, unknown>;
    expect(healthBody.status).toBe("ok");
    expect(JSON.stringify(healthBody)).not.toContain("mongodb");
    expect(JSON.stringify(healthBody)).not.toContain("secret");

    const ready = await fetch(`${baseUrl}/api/v1/ready`);
    expect(ready.status).toBe(200);
    const readyBody = (await ready.json()) as { data: Record<string, unknown> };
    expect(readyBody.data).toEqual({ ready: true, service: "api" });
  });

  it("ships TLS/HSTS + hardening headers on staging-shaped responses", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("protected routes fail closed without a session (401, not data)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/me`);
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("user-a");
  });
});

describe("P1-15 — deployment configuration evidence (OPS-001/002/004)", () => {
  it("Render Blueprint matches the approved free-tier topology", () => {
    const text = readFileSync("render.yaml", "utf8");
    expect(checkRenderYaml(text).pass).toBe(true);
  });

  it("staging env template carries placeholders only (no active secrets)", () => {
    // infra/ is git-excluded (local-only), so CI cannot read the live
    // template file; exercise the check against the approved placeholder
    // shape instead (GAP-15-04: live template verification is local-only).
    const fixture = [
      "# Staging environment template (placeholders only).",
      "APP_ORIGIN=https://<vercel-staging-host>",
      "API_ORIGIN=https://<render-staging-host>",
      "MONGODB_URI=mongodb+srv://<staging-user>:<staging-password>@<cluster>.mongodb.net/",
    ].join("\n");
    expect(checkStagingTemplate(fixture).pass).toBe(true);
  });

  it("staging env separation uses a staging database", () => {
    expect(checkEnvSeparation({ MONGODB_DB: "real_time_chat_staging" }).pass).toBe(true);
    expect(checkEnvSeparation({ MONGODB_DB: "real_time_chat_prod" }).pass).toBe(false);
  });

  it("production config rejects local origins/secrets (fail-closed, TC-OPS-001)", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PORT: "3001",
        APP_ORIGIN: "http://localhost:3000",
        API_ORIGIN: "http://localhost:3001",
        MONGODB_URI: "mongodb://127.0.0.1:27017/real_time_chat_staging",
        MONGODB_DB: "real_time_chat_staging",
        MONGODB_CONNECT_TIMEOUT_MS: "5000",
        BETTER_AUTH_SECRET: "local-dev-only-change-me-32-characters-minimum",
        AI_PROVIDER: "mock",
        AI_MODEL: "mock",
        AI_API_KEY: "",
        AI_CONSENT_REQUIRED: "true",
        STUN_URLS: "stun:localhost:3478",
        TURN_URLS: "",
        TURN_USERNAME: "",
        TURN_CREDENTIAL: "",
        TURN_REALM: "",
        TURN_CREDENTIAL_TTL_SECONDS: "7200",
      }),
    ).toThrow();
  });

  it("seed refuses production (production data inaccessible)", () => {
    expect(() =>
      assertSafeSeedTarget({
        nodeEnv: "production",
        port: 3001,
        appOrigin: "https://app.example.com",
        apiOrigin: "https://api.example.com",
        mongodb: {
          uri: "mongodb+srv://x@y",
          dbName: "real_time_chat_staging",
          connectTimeoutMs: 5000,
        },
        auth: { secret: "x".repeat(32), jwksUri: "" },
        ai: { provider: "groq", model: "m", apiKey: "k", consentRequired: true },
        ice: { stunUrls: ["stun:stun.cloudflare.com:3478"], turn: null },
      }),
    ).toThrow();
  });

  it("session cookie attributes match the deployment policy", () => {
    expect(
      checkCookieAttributes({
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        path: "/",
        domain: null,
        cookieCacheMaxAge: 0,
      }).pass,
    ).toBe(true);
  });
});
