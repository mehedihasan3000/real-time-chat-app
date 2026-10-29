import { describe, expect, it } from "vitest";

describe("required check proof", () => {
  it("fails intentionally to prove a red ci check blocks merge", () => {
    expect("red").toBe("green");
  });
});
