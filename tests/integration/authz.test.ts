import { describe, expect, it } from "vitest";

import {
  canAccessBlock,
  canAccessCall,
  canAccessConversation,
  canAccessDevice,
  canAccessKeyBackup,
  canAccessMessage,
  canAccessReceipt,
  canAccessReport,
  derivePrincipal,
  guardOperator,
  guardSensitive,
} from "../../apps/api/src/authz/index.js";
import type { Principal } from "../../apps/api/src/authz/index.js";
import {
  authorizeSocketConversationJoin,
  authorizeSocketEvent,
} from "../../apps/api/src/authz/index.js";

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: "user-a",
    sid: "sid-a",
    emailVerified: true,
    role: "user",
    sessionValid: true,
    sessionFresh: true,
    authenticatedAt: new Date(),
    ...overrides,
  };
}

const CONV_AB = { id: "conv-1", participantIds: ["user-a", "user-b"] as const };
const CONV_CD = { id: "conv-2", participantIds: ["user-c", "user-d"] as const };

describe("TC-SEC-005 — HTTP object-level matrix (INT-002 / FR-SEC-008)", () => {
  it("allows a participant on their private conversation", () => {
    const result = canAccessConversation(principal(), CONV_AB);
    expect(result.ok).toBe(true);
  });

  it("rejects a nonparticipant with uniform 404 (enumeration-safe)", () => {
    const nonparticipant = canAccessConversation(principal(), CONV_CD);
    const missing = canAccessConversation(principal(), null);
    expect(nonparticipant.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (!nonparticipant.ok && !missing.ok) {
      // Same code, status, and message — existence is not disclosed.
      expect(nonparticipant.denial.code).toBe(missing.denial.code);
      expect(nonparticipant.denial.httpStatus).toBe(404);
      expect(nonparticipant.denial.message).toBe(missing.denial.message);
    }
  });

  it("rejects a null principal as revoked session (401)", () => {
    const result = canAccessConversation(null, CONV_AB);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.denial.code).toBe("SESSION_REVOKED");
      expect(result.denial.httpStatus).toBe(401);
    }
  });

  it("rejects an unverified principal from protected resources", () => {
    const result = canAccessConversation(principal({ emailVerified: false }), CONV_AB);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denial.code).toBe("FORBIDDEN");
  });

  it("covers message, receipt, call, backup, device, report, and block", () => {
    const message = { id: "msg-1", conversationId: "conv-1", senderUserId: "user-a" };
    const receipt = {
      id: "rec-1",
      messageId: "msg-1",
      conversationId: "conv-1",
      senderUserId: "user-a",
      recipientUserId: "user-b",
    };
    const call = { id: "call-1", callId: "call-1", participantIds: ["user-a", "user-b"] as const };
    const backup = { id: "bak-1", ownerId: "user-a" };
    const device = { id: "dev-1", ownerId: "user-a", deviceId: "device-1" };
    const report = { id: "rep-1", reporterUserId: "user-a", reportedUserId: "user-b" };
    const block = { id: "blk-1", blockerUserId: "user-a", blockedUserId: "user-b" };

    expect(canAccessMessage(principal(), message, CONV_AB).ok).toBe(true);
    expect(canAccessReceipt(principal(), receipt).ok).toBe(true);
    expect(canAccessCall(principal(), call).ok).toBe(true);
    expect(canAccessKeyBackup(principal(), backup).ok).toBe(true);
    expect(canAccessDevice(principal(), device).ok).toBe(true);
    expect(canAccessReport(principal(), report).ok).toBe(true);
    expect(canAccessBlock(principal(), block).ok).toBe(true);

    // Unrelated user is rejected on every private kind.
    const stranger = principal({ userId: "user-z" });
    for (const result of [
      canAccessMessage(stranger, message, CONV_AB),
      canAccessReceipt(stranger, receipt),
      canAccessCall(stranger, call),
      canAccessKeyBackup(stranger, backup),
      canAccessDevice(stranger, device),
      canAccessReport(stranger, report),
      canAccessBlock(
        stranger,
        report ? { id: "blk-1", blockerUserId: "user-a", blockedUserId: "user-b" } : null,
      ),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.denial.httpStatus).toBe(404);
    }
  });

  it("hides receipts from the recipient (sender-only visibility)", () => {
    const receipt = {
      id: "rec-1",
      messageId: "msg-1",
      conversationId: "conv-1",
      senderUserId: "user-a",
      recipientUserId: "user-b",
    };
    const recipient = principal({ userId: "user-b" });
    expect(canAccessReceipt(recipient, receipt).ok).toBe(false);
  });

  it("hides reports from the reported user (no reporter identity)", () => {
    const report = { id: "rep-1", reporterUserId: "user-a", reportedUserId: "user-b" };
    const reported = principal({ userId: "user-b" });
    const result = canAccessReport(reported, report);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denial.httpStatus).toBe(404);
  });

  it("enforces vertical role checks (operator-only moderation)", () => {
    expect(guardOperator(principal()).ok).toBe(false);
    expect(guardOperator(principal({ role: "operator" })).ok).toBe(true);
  });

  it("enforces freshness for sensitive actions", () => {
    expect(guardSensitive(principal({ sessionFresh: true })).ok).toBe(true);
    const stale = guardSensitive(principal({ sessionFresh: false }));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.denial.code).toBe("FORBIDDEN");
  });
});

describe("P1-07 — server-derived principal (no client ownership fields)", () => {
  it("derives userId from JWT sub only, ignoring client ownership", () => {
    const claims = {
      sub: "user-a",
      sid: "sid-a",
      emailVerified: true,
      iss: "http://127.0.0.1:3000",
      aud: "http://127.0.0.1:3001",
      exp: 0,
      iat: 0,
    };
    const session = {
      sid: "sid-a",
      userId: "user-a",
      revoked: false,
      authenticatedAt: new Date(),
    };
    const derived = derivePrincipal(claims, session);
    expect(derived?.userId).toBe("user-a");
  });

  it("rejects sid/sub mismatch as revoked", () => {
    const claims = {
      sub: "user-a",
      sid: "sid-a",
      emailVerified: true,
      iss: "http://127.0.0.1:3000",
      aud: "http://127.0.0.1:3001",
      exp: 0,
      iat: 0,
    };
    const forgedSession = {
      sid: "sid-a",
      userId: "user-evil",
      revoked: false,
      authenticatedAt: new Date(),
    };
    expect(derivePrincipal(claims, forgedSession)).toBeNull();
  });

  it("rejects revoked/missing sessions", () => {
    const claims = {
      sub: "user-a",
      sid: "sid-a",
      emailVerified: true,
      iss: "http://127.0.0.1:3000",
      aud: "http://127.0.0.1:3001",
      exp: 0,
      iat: 0,
    };
    expect(derivePrincipal(claims, null)).toBeNull();
    expect(
      derivePrincipal(claims, {
        sid: "sid-a",
        userId: "user-a",
        revoked: true,
        authenticatedAt: new Date(),
      }),
    ).toBeNull();
  });
});

describe("TC-SEC-005 — socket stale-room and event recheck (INT-004)", () => {
  const store = new Map<string, { id: string; participantIds: string[] }>([
    ["conv-1", { id: "conv-1", participantIds: ["user-a", "user-b"] }],
  ]);
  const authorizer = {
    conversationLookup: async (id: string) => store.get(id) ?? null,
    callLookup: async (id: string) =>
      id === "call-1"
        ? { id: "call-1", callId: "call-1", participantIds: ["user-a", "user-b"] }
        : null,
  };

  it("allows a participant to join their conversation room", async () => {
    const result = await authorizeSocketConversationJoin(principal(), "conv-1", authorizer);
    expect(result.ok).toBe(true);
  });

  it("rejects a nonparticipant joining a room (uniform NOT_FOUND)", async () => {
    const result = await authorizeSocketConversationJoin(
      principal({ userId: "user-z" }),
      "conv-1",
      authorizer,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denial.httpStatus).toBe(404);
  });

  it("rejects a stale room after membership removal (formerly valid)", async () => {
    // User was in conv-1 previously; after removal only user-b remains.
    store.set("conv-1", { id: "conv-1", participantIds: ["user-b"] });
    const stale = await authorizeSocketConversationJoin(principal(), "conv-1", authorizer);
    expect(stale.ok).toBe(false);
    // Restore for subsequent tests.
    store.set("conv-1", { id: "conv-1", participantIds: ["user-a", "user-b"] });

    const event = await authorizeSocketEvent(
      principal(),
      "message:new",
      { schemaVersion: 1, conversationId: "conv-1", data: {} },
      authorizer,
    );
    expect(event.ok).toBe(true);
  });

  it("rejects sensitive socket events on a stale session", async () => {
    const stalePrincipal = principal({ sessionFresh: false });
    const result = await authorizeSocketEvent(
      stalePrincipal,
      "call:connected",
      { schemaVersion: 1, conversationId: "conv-1", data: { callId: "call-1" } },
      authorizer,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denial.code).toBe("FORBIDDEN");
  });

  it("rejects revoked principals on every socket event", async () => {
    const result = await authorizeSocketEvent(
      null,
      "message:new",
      { schemaVersion: 1, conversationId: "conv-1", data: {} },
      authorizer,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denial.code).toBe("SESSION_REVOKED");
  });
});
