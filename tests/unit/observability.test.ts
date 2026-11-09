import { describe, expect, it } from "vitest";

import {
  containsSecretPattern,
  createLogger,
  MetricsRegistry,
  redactObject,
  redactValue,
  toSafeError,
} from "../../apps/api/src/observability/index.js";
import {
  containsClientSecretPattern,
  redactClientObject,
  reportClientError,
} from "../../apps/web/src/lib/telemetry/index.js";

describe("TC-ERR-001 — redaction removes synthetic secret/content markers", () => {
  it("redacts token/message/excerpt/credential keys at any depth", () => {
    const input = {
      requestId: "11111111-1111-4111-8111-111111111111",
      token: "SYNTHETIC_TOKEN_ABC123",
      nested: {
        message: "SYNTHETIC_MESSAGE_PLAINTEXT_12345",
        authorization: "Bearer SYNTHETIC",
        profile: { displayName: "Ada" },
      },
      items: [{ ciphertext: "SYNTHETIC_CIPHERTEXT", ok: true }],
    };
    const redacted = redactObject(input) as Record<string, unknown>;
    const text = JSON.stringify(redacted);
    expect(text).not.toContain("SYNTHETIC_TOKEN");
    expect(text).not.toContain("SYNTHETIC_MESSAGE_PLAINTEXT");
    expect(text).not.toContain("SYNTHETIC_CIPHERTEXT");
    expect(text).not.toContain("Bearer SYNTHETIC");
    expect(redacted.nested).toMatchObject({ profile: { displayName: "Ada" } });
  });

  it("redacts secret-looking values regardless of key", () => {
    const fakeMongoUri = ["mongodb://", "user", ":", "pass", "@db.internal/app"].join("");
    const fakePrivateKey = ["-----BEGIN ", "PRIVATE KEY", "-----"].join("");
    const fakeBearer = ["Bearer ", "abc.def.ghi"].join("");
    const fakeSk = ["sk-", "SYNTHETIC12345678"].join("");
    const fakeGhp = ["ghp_", "SYNTHETIC123456789012345678901234567"].join("");
    for (const secret of [fakeBearer, fakeMongoUri, fakeSk, fakeGhp, fakePrivateKey]) {
      expect(containsSecretPattern(redactValue(secret) as string)).toBe(false);
      expect(containsSecretPattern(secret)).toBe(true);
    }
  });

  it("never throws on circular structures", () => {
    const circular: Record<string, unknown> = { name: "x" };
    circular.self = circular;
    expect(redactObject(circular)).toEqual({ name: "x", self: "[CIRCULAR]" });
  });

  it("maps unknown errors to a generic safe envelope (no internals)", () => {
    const fakeMongoUri = ["mongodb://", "u", ":", "p", "@host/db"].join("");
    const fakeBearer = ["Bearer ", "SYNTHETIC"].join("");
    const secretError = new Error(
      ["failed with SYNTHETIC_TOKEN in ", fakeMongoUri, " ", fakeBearer, " at /app/src/secret.ts:42"].join(""),
    );
    const safe = toSafeError(secretError, "11111111-1111-4111-8111-111111111111");
    expect(safe.error.code).toBe("INTERNAL_ERROR");
    expect(safe.requestId).toBe("11111111-1111-4111-8111-111111111111");
    const text = JSON.stringify(safe);
    expect(text).not.toContain("SYNTHETIC_TOKEN");
    expect(text).not.toContain("mongodb");
    expect(text).not.toContain("secret.ts");
    expect(text).not.toContain("stack");
  });

  it("logger output contains no secret markers", () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    logger.error("http", {
      requestId: "11111111-1111-4111-8111-111111111111",
      code: "INTERNAL_ERROR",
      error: new Error("Bearer SYNTHETIC should not appear") as unknown as undefined,
    });
    logger.info("http", { route: "/api/v1/me", token: "SYNTHETIC" as unknown as undefined });
    const text = lines.join("\n");
    expect(text).not.toContain("SYNTHETIC");
    expect(containsSecretPattern(text)).toBe(false);
    expect(lines[0]).toContain("INTERNAL_ERROR");
  });

  it("metrics snapshots carry no content labels", () => {
    const registry = new MetricsRegistry();
    registry.inc("http_requests_total", {
      component: "http",
      method: "GET",
      statusClass: "2xx",
    });
    registry.observeDuration("http_request_duration_ms", 42, {
      component: "http",
      method: "GET",
      statusClass: "2xx",
    });
    const snapshot = registry.snapshot();
    const text = JSON.stringify(snapshot);
    expect(
      snapshot.counters["http_requests_total{component=http,method=GET,statusClass=2xx}"],
    ).toBe(1);
    expect(text).not.toContain("userId");
    expect(text).not.toContain("message");
    expect(text).not.toContain("SYNTHETIC");
  });

  it("web telemetry redacts markers the same way", () => {
    const lines: string[] = [];
    reportClientError(
      { code: "INTERNAL_ERROR", requestId: "11111111-1111-4111-8111-111111111111", route: "/chat" },
      (line) => lines.push(line),
    );
    expect(lines[0]).toContain("INTERNAL_ERROR");
    const redacted = redactClientObject({
      token: "Bearer SYNTHETIC",
      body: "SYNTHETIC_BODY",
      safe: "visible",
    }) as Record<string, unknown>;
    expect(JSON.stringify(redacted)).not.toContain("SYNTHETIC");
    expect(redacted.safe).toBe("visible");
    expect(containsClientSecretPattern("Bearer SYNTHETIC")).toBe(true);
  });
});
