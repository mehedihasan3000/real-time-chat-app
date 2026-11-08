import { describe, expect, it } from "vitest";

import {
  ERROR_HTTP_STATUS,
  PAGE_DEFAULT,
  PAGE_MAX,
  SCHEMA_VERSION,
  checkSchemaVersion,
  decodeCursor,
  encodeCursor,
  failureEnvelope,
  isRequestId,
  newRequestId,
  successEnvelope,
  validateHistoryQuery,
  validatePageLimit,
  validateSendMessageRequest,
  validateSocketPayload,
} from "@chat/contracts";

const VALID_UUID = "123e4567-e89b-42d3-a456-426614174000";

function envelopeOf(byteLength: number): string {
  return Buffer.alloc(byteLength, 0).toString("base64url");
}

describe("TC-INT-001 v0 — valid send-message inputs", () => {
  it("accepts a well-formed v1 send request", () => {
    const result = validateSendMessageRequest({
      schemaVersion: SCHEMA_VERSION,
      clientMessageId: VALID_UUID,
      senderDeviceId: "device-1",
      protocolVersion: "olm-v1",
      encryptedEnvelope: envelopeOf(100),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.clientMessageId).toBe(VALID_UUID);
    }
  });

  it("accepts pagination defaults and cursor round-trip", () => {
    expect(validatePageLimit(undefined)).toEqual({ ok: true, value: PAGE_DEFAULT });
    expect(validatePageLimit(100)).toEqual({ ok: true, value: PAGE_MAX });
    const cursor = encodeCursor(42);
    expect(decodeCursor(cursor)).toEqual({ ok: true, value: { v: 1, seq: 42 } });
    expect(validateHistoryQuery({ limit: "50", after: cursor })).toEqual({
      ok: true,
      value: { limit: 50, before: null, after: { v: 1, seq: 42 } },
    });
  });

  it("builds success/failure envelopes with request IDs", () => {
    const ok = successEnvelope({ hello: "world" });
    expect(ok.ok).toBe(true);
    expect(isRequestId(ok.requestId)).toBe(true);
    const bad = failureEnvelope("NOT_FOUND", "Not here.", false);
    expect(bad).toMatchObject({ ok: false, error: { code: "NOT_FOUND", retryable: false } });
    expect(ERROR_HTTP_STATUS.NOT_FOUND).toBe(404);
  });

  it("accepts a v1 socket payload and exposes the event catalogue", () => {
    const result = validateSocketPayload({
      schemaVersion: 1,
      conversationId: "conv-1",
      data: { seq: 7 },
    });
    expect(result.ok).toBe(true);
    expect(checkSchemaVersion(1)).toEqual({ ok: true });
    expect(newRequestId().length).toBeGreaterThan(0);
  });
});

describe("TC-INT-001 v0 — malformed inputs", () => {
  it("rejects non-object bodies and missing identity fields", () => {
    expect(validateSendMessageRequest(null).ok).toBe(false);
    expect(validateSendMessageRequest("string").ok).toBe(false);
    const missing = validateSendMessageRequest({
      schemaVersion: 1,
      clientMessageId: "not-a-uuid",
      senderDeviceId: "",
      protocolVersion: "",
      encryptedEnvelope: "",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("INVALID_REQUEST");
  });

  it("rejects non-base64url envelopes and bad cursors", () => {
    const badEnvelope = validateSendMessageRequest({
      schemaVersion: 1,
      clientMessageId: VALID_UUID,
      senderDeviceId: "device-1",
      protocolVersion: "olm-v1",
      encryptedEnvelope: "!!!not-base64!!!",
    });
    expect(badEnvelope.ok).toBe(false);
    // Single-char base64url decodes to 0 bytes and must be rejected
    expect(
      validateSendMessageRequest({
        schemaVersion: 1,
        clientMessageId: VALID_UUID,
        senderDeviceId: "device-1",
        protocolVersion: "olm-v1",
        encryptedEnvelope: "A",
      }).ok,
    ).toBe(false);
    expect(decodeCursor("not-a-cursor").ok).toBe(false);
    expect(decodeCursor("not-a-cursor")).toMatchObject({ code: "INVALID_CURSOR" });
    expect(validatePageLimit("abc").ok).toBe(false);
    expect(validateHistoryQuery({ before: encodeCursor(1), after: encodeCursor(2) }).ok).toBe(
      false,
    );
    expect(validateSocketPayload({ schemaVersion: 1 }).ok).toBe(false);
  });
});

describe("TC-INT-001 v0 — oversized inputs", () => {
  it("rejects envelopes over 16 KiB with PAYLOAD_TOO_LARGE", () => {
    const result = validateSendMessageRequest({
      schemaVersion: 1,
      clientMessageId: VALID_UUID,
      senderDeviceId: "device-1",
      protocolVersion: "olm-v1",
      encryptedEnvelope: envelopeOf(16 * 1024 + 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PAYLOAD_TOO_LARGE");
      expect(ERROR_HTTP_STATUS.PAYLOAD_TOO_LARGE).toBe(413);
    }
  });

  it("rejects limits above the 100 maximum", () => {
    expect(validatePageLimit(101).ok).toBe(false);
    expect(validateHistoryQuery({ limit: "200" }).ok).toBe(false);
  });
});

describe("TC-INT-001 v0 — unknown-version inputs", () => {
  it("maps wrong schemaVersion to UNSUPPORTED_SCHEMA_VERSION (422)", () => {
    const result = validateSendMessageRequest({
      schemaVersion: 2,
      clientMessageId: VALID_UUID,
      senderDeviceId: "device-1",
      protocolVersion: "olm-v1",
      encryptedEnvelope: envelopeOf(10),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNSUPPORTED_SCHEMA_VERSION");
      expect(ERROR_HTTP_STATUS.UNSUPPORTED_SCHEMA_VERSION).toBe(422);
    }
    expect(checkSchemaVersion(99)).toEqual({ ok: false, code: "UNSUPPORTED_SCHEMA_VERSION" });
    expect(validateSocketPayload({ schemaVersion: 0, data: {} }).ok).toBe(false);
    expect(
      validateHistoryQuery({ limit: "50", before: encodeCursor(1), after: encodeCursor(1) }).ok,
    ).toBe(false);
  });
});
