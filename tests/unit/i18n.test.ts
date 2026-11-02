import { describe, expect, it } from "vitest";

import bn from "../../apps/web/messages/bn.json";
import en from "../../apps/web/messages/en.json";
import {
  formatDateTime,
  formatDuration,
  getDisplayTimeZone,
  resolveMessage,
  toBcp47,
} from "../../apps/web/src/i18n/core.js";
import { errorCopyFor, isKnownErrorCode } from "../../apps/web/src/i18n/errors.js";

describe("catalogs", () => {
  it("have identical key sets", () => {
    expect(Object.keys(bn).sort()).toEqual(Object.keys(en).sort());
  });

  it("have no empty values", () => {
    for (const catalog of [en, bn]) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.trim(), key).not.toBe("");
      }
    }
  });

  it("keep interpolation placeholders in sync", () => {
    const placeholders = (value: string) => (value.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort();

    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(placeholders(bn[key]), key).toEqual(placeholders(en[key]));
    }
  });
});

describe("resolveMessage", () => {
  it("interpolates named values", () => {
    expect(
      resolveMessage("en", "thread.descriptionWithUsername", { username: "nusrat_j" }),
    ).toContain("@nusrat_j");
  });

  it("selects the plural category for the active locale", () => {
    expect(resolveMessage("en", "time.messageCount", { count: 1 })).toBe("1 synthetic sample");
    expect(resolveMessage("en", "time.messageCount", { count: 3 })).toBe("3 synthetic samples");
    expect(resolveMessage("bn", "time.messageCount", { count: 3 })).toContain("কৃত্রিম");
  });

  it("formats numbers with the locale's digits", () => {
    expect(resolveMessage("bn", "time.itemCount", { count: 2 })).toBe("২টি আইটেম");
  });

  it("leaves unknown placeholders intact", () => {
    expect(resolveMessage("en", "common.generatedAvatarFor", {})).toBe(
      "Generated avatar for {name}",
    );
  });

  it("preserves Unicode user content through interpolation", () => {
    const content = "নমস্কার 🌸 hello — কেমন আছ? 👩🏽‍💻";

    expect(resolveMessage("bn", "common.generatedAvatarFor", { name: content })).toContain(content);
    expect(resolveMessage("en", "common.generatedAvatarFor", { name: content })).toContain(content);
  });

  it("falls back to the key when no message exists", () => {
    expect(resolveMessage("en", "missing.key")).toBe("missing.key");
  });

  it("exposes BCP 47 tags for both locales", () => {
    expect(toBcp47("en")).toBe("en-GB");
    expect(toBcp47("bn")).toBe("bn-BD");
  });
});

describe("formatDateTime", () => {
  const instant = "2026-10-31T09:41:00.000Z";

  it("formats a UTC instant for the selected locale and timezone", () => {
    expect(formatDateTime(instant, "en", "UTC")).toContain("31 Oct 2026");
    expect(formatDateTime(instant, "bn", "UTC")).toContain("২০২৬");
  });

  it("respects an explicit timezone", () => {
    const utc = formatDateTime(instant, "en", "UTC", { hour: "2-digit", minute: "2-digit" });
    const dhaka = formatDateTime(instant, "en", "Asia/Dhaka", {
      hour: "2-digit",
      minute: "2-digit",
    });

    expect(utc).not.toBe(dhaka);
  });

  it("returns an empty string for an invalid instant", () => {
    expect(formatDateTime("not-a-date", "en", "UTC")).toBe("");
  });

  it("falls back to UTC for an invalid timezone", () => {
    expect(formatDateTime(instant, "en", "Not/AZone", { timeZoneName: "short" })).toContain("UTC");
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes, and mixed durations", () => {
    expect(formatDuration(0, "en")).toBe("0 s");
    expect(formatDuration(45, "en")).toBe("45 s");
    expect(formatDuration(120, "en")).toBe("2 min");
    expect(formatDuration(252, "en")).toBe("4 min 12 s");
  });

  it("localizes the duration labels", () => {
    expect(formatDuration(252, "bn")).toBe("৪ মিনিট ১২ সেকেন্ড");
  });
});

describe("getDisplayTimeZone", () => {
  it("returns a non-empty timezone", () => {
    expect(getDisplayTimeZone().length).toBeGreaterThan(0);
  });
});

describe("errorCopyFor", () => {
  it("maps a known stable code to reviewed copy", () => {
    const copy = errorCopyFor("RATE_LIMITED");

    expect(copy.code).toBe("RATE_LIMITED");
    expect(copy.titleKey).toBe("errors.RATE_LIMITED.title");
    expect(isKnownErrorCode(copy.code)).toBe(true);
  });

  it("never surfaces raw provider text", () => {
    const raw = "MongoServerError: connection refused at 10.0.0.4";

    expect(errorCopyFor(raw)).toEqual({
      code: null,
      titleKey: "errors.unknown.title",
      descriptionKey: "errors.unknown.description",
    });
  });

  it("rejects arbitrary non-string values", () => {
    expect(errorCopyFor({ message: "raw" }).code).toBeNull();
    expect(errorCopyFor(undefined).code).toBeNull();
  });
});
