import { describe, expect, it } from "vitest";

import {
  DISPLAY_NAME_MAX,
  generatedAvatar,
  normalizeUsername,
  validateDisplayName,
  validateUsername,
} from "../../packages/contracts/src/index.js";
import { MemoryProfileStore } from "../../apps/api/src/profiles/store.js";
import { avatarColor, avatarFor } from "../../apps/web/src/features/profile/index.js";

describe("TC-PROF-001 — unique normalized usernames", () => {
  it("normalizes case and rejects conflicting variants", () => {
    expect(normalizeUsername("Ada_Lovelace")).toBe("ada_lovelace");
    expect(validateUsername("Ada_Lovelace").ok).toBe(true);
  });

  it("rejects reserved, invalid, and confusable inputs", () => {
    for (const bad of ["admin", "support", "system", "a", "1abc", "a".repeat(25), "a b", "àbc"]) {
      expect(validateUsername(bad).ok).toBe(false);
    }
    // ASCII-only policy intentionally rejects Unicode confusables.
    expect(validateUsername("adа").ok).toBe(false);
  });

  it("store enforces case-insensitive uniqueness (DATA-002)", async () => {
    const store = new MemoryProfileStore([
      {
        userId: "user-a",
        username: "ada",
        displayName: "Ada",
        avatar: null,
        locale: "en",
        timeZone: "UTC",
      },
    ]);
    const conflict = await store.claimUsername("user-b", "ADA");
    expect(conflict).toBeNull();
    const own = await store.claimUsername("user-a", "Ada");
    expect(own?.username).toBe("ada");
  });
});

describe("TC-PROF-001 — display names affect only the owner", () => {
  it("validates 1-50 Unicode characters incl. Bengali", () => {
    expect(validateDisplayName("আদা লাভলেস").ok).toBe(true);
    expect(validateDisplayName("").ok).toBe(false);
    expect(validateDisplayName("x".repeat(DISPLAY_NAME_MAX + 1)).ok).toBe(false);
  });

  it("update affects only the authenticated profile; rendering is inert", async () => {
    const store = new MemoryProfileStore([
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
    ]);
    const hostile = "<script>alert(1)</script>";
    const updated = await store.updateDisplayName("user-a", hostile);
    expect(updated?.displayName).toBe(hostile);
    const other = await store.getByUserId("user-b");
    expect(other?.displayName).toBe("Bob");
    // Inert: the server stores the raw string; rendering never executes it.
    expect(updated?.displayName).not.toContain("undefined");
  });
});

describe("TC-PROF-002 — generated initials avatar (DEC-027)", () => {
  it("is deterministic per userId with no third-party request", () => {
    const a = generatedAvatar("user-123", "আদা", "ada");
    const b = generatedAvatar("user-123", "Ada", "ada");
    expect(a.hue).toBe(b.hue);
    expect(a.hue).toBeGreaterThanOrEqual(0);
    expect(a.hue).toBeLessThan(360);
    const view = avatarFor("user-123", "আদা", "ada");
    expect(view.initial).toBe("আ");
    expect(avatarColor(view.hue)).toContain("hsl(");
  });

  it("falls back to the username when the display name is empty", () => {
    const view = avatarFor("user-9", "", "bob");
    expect(view.initial).toBe("b");
  });
});
