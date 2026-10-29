import { describe, expect, it } from "vitest";

import { avatarToneFor, firstGrapheme } from "../../apps/web/lib/avatar.js";

describe("firstGrapheme", () => {
  it("returns the first Latin grapheme", () => {
    expect(firstGrapheme("Nusrat")).toBe("N");
  });

  it("returns the first Bengali grapheme cluster", () => {
    expect(firstGrapheme("  বাংলা")).toBe("বাং");
    expect(firstGrapheme("বল")).toBe("ব");
  });

  it("keeps combining marks attached to the base grapheme", () => {
    expect(firstGrapheme("e\u0301clair")).toBe("e\u0301");
  });

  it("returns a fallback for empty and whitespace-only values", () => {
    expect(firstGrapheme("")).toBe("?");
    expect(firstGrapheme("   ")).toBe("?");
  });
});

describe("avatarToneFor", () => {
  it("is deterministic and stays within the hue range", () => {
    const hue = avatarToneFor("preview-self");

    expect(avatarToneFor("preview-self")).toBe(hue);
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });

  it("separates different identifiers", () => {
    expect(avatarToneFor("user-1")).not.toBe(avatarToneFor("user-2"));
  });
});
