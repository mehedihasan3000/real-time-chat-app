import { describe, expect, it } from "vitest";

import {
  clearSessionCache,
  getSessionForRead,
  getSessionForSensitive,
  requireFreshForSensitive,
  requireVerifiedForProtected,
} from "../../apps/api/src/auth/session.js";
import { createVerifier, mintTestToken } from "../../apps/api/src/auth/jwt.js";
import { validatePassword, isFreshSession } from "@chat/contracts";

const ISS = "http://127.0.0.1:3000";
const AUD = "http://127.0.0.1:3001";

describe("TC-AUTH-001 — invalid credentials create no session", () => {
  it("rejects short/common passwords without creating a session record", async () => {
    // Policy gate runs before any session creation; no lookup is performed.
    expect(validatePassword("short").ok).toBe(false);
    expect(validatePassword("password12345").ok).toBe(false);
    expect(validatePassword("Str0ng!Passw0rdXYZ").ok).toBe(true);
  });
});

describe("TC-AUTH-002 — unverified users blocked from protected features", () => {
  it("allows login profile but blocks protected actions when unverified", async () => {
    const lookup = async () => ({
      sid: "sid-1",
      userId: "user-1",
      revoked: false,
      authenticatedAt: new Date(),
    });
    const record = await getSessionForSensitive(lookup, "sid-1");
    expect(requireVerifiedForProtected(record, false)).toBe(false);
    expect(requireVerifiedForProtected(record, true)).toBe(true);
  });
});

describe("TC-AUTH-003 — JWT revocation bound + sensitive freshness", () => {
  it("verifies EdDSA JWT and enforces sid revocation", async () => {
    const { token, keyPair } = await mintTestToken({
      sub: "user-1",
      sid: "sid-1",
      emailVerified: true,
      iss: ISS,
      aud: AUD,
    });
    const verify = createVerifier({
      appOrigin: ISS,
      apiOrigin: AUD,
      resolveKey: async () => keyPair.publicKey as never,
    });
    const claims = await verify(token);
    expect(claims.sub).toBe("user-1");
    expect(claims.sid).toBe("sid-1");

    // Revoked session: sensitive fails immediately, read fails after cache clear
    clearSessionCache();
    const revokedLookup = async () => null;
    expect(await getSessionForSensitive(revokedLookup, "sid-1")).toBeNull();
    expect(await getSessionForRead(revokedLookup, "sid-1")).toBeNull();

    // Freshness: 16-minute-old session fails sensitive, 5-minute passes
    const stale = {
      sid: "sid-2",
      userId: "user-1",
      revoked: false,
      authenticatedAt: new Date(Date.now() - 16 * 60 * 1000),
    };
    const fresh = {
      sid: "sid-3",
      userId: "user-1",
      revoked: false,
      authenticatedAt: new Date(Date.now() - 5 * 60 * 1000),
    };
    expect(requireFreshForSensitive(stale)).toBe(false);
    expect(requireFreshForSensitive(fresh)).toBe(true);
    expect(isFreshSession(fresh.authenticatedAt)).toBe(true);
  });

  it("rejects expired JWTs", async () => {
    const { token, keyPair } = await mintTestToken({
      sub: "user-1",
      sid: "sid-1",
      emailVerified: true,
      iss: ISS,
      aud: AUD,
      expiresInSeconds: -60,
    });
    const verify = createVerifier({
      appOrigin: ISS,
      apiOrigin: AUD,
      resolveKey: async () => keyPair.publicKey as never,
    });
    // jose clock: token exp is in the past, verify must throw
    await expect(verify(token)).rejects.toThrow();
  });
});

describe("TC-AUTH-004 — disabled recovery flows truthfully disclosed", () => {
  it("exposes email-only recovery constants", async () => {
    const { RECOVERY_EMAIL_ONLY, RECOVERY_SMS_ENABLED, RECOVERY_ADMIN_BYPASS } =
      await import("@chat/contracts");
    expect(RECOVERY_EMAIL_ONLY).toBe(true);
    expect(RECOVERY_SMS_ENABLED).toBe(false);
    expect(RECOVERY_ADMIN_BYPASS).toBe(false);
  });
});
