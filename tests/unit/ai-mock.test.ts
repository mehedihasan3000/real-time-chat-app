import { describe, expect, it } from "vitest";
import { createAiProvider } from "../../apps/api/src/ai/index.js";
import { MockAiProvider } from "../../apps/api/src/ai/mock.js";
import { ConfigError, loadConfig } from "../../apps/api/src/config.js";
import { baseEnv } from "../fixtures/env.js";

describe("MockAiProvider", () => {
  it("returns a deterministic synthetic response", async () => {
    const provider = new MockAiProvider();
    const result = await provider.complete({
      operation: "smoke",
      input: "synthetic local input",
    });

    expect(provider.id).toBe("mock");
    expect(result).toEqual({
      provider: "mock",
      model: "mock",
      text: "[mock:smoke] Synthetic local development response.",
      synthetic: true,
    });
  });

  it("uses the configured model name", async () => {
    const provider = new MockAiProvider("mock-model-v2");
    const result = await provider.complete({
      operation: "translation",
      input: "synthetic local input",
    });

    expect(result.model).toBe("mock-model-v2");
    expect(result.text).toContain("[mock:translation]");
  });
});

describe("createAiProvider", () => {
  it("creates the local mock provider", () => {
    const provider = createAiProvider(loadConfig(baseEnv));

    expect(provider).toBeInstanceOf(MockAiProvider);
    expect(provider.id).toBe("mock");
  });

  it("fails closed for an unimplemented provider", () => {
    const config = loadConfig(baseEnv);
    const unsupported = {
      ...config,
      ai: { ...config.ai, provider: "groq" as const },
    };

    let error: unknown;
    try {
      createAiProvider(unsupported);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues.join("\n")).toContain("not implemented yet");
  });
});
