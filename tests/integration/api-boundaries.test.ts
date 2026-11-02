import type { Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAiProvider } from "../../apps/api/src/ai/index.js";
import { createApp } from "../../apps/api/src/app.js";
import type { AppConfig } from "../../apps/api/src/config.js";
import { ConfigError } from "../../apps/api/src/config.js";

/**
 * Integration boundary checks.
 *
 * These exercise the real Express app on an ephemeral port and the real AI
 * adapter selection. The provider is the network-free mock, so this is not a
 * real-provider acceptance test.
 */
let server: Server;
let baseUrl: string;

const mockConfig: AppConfig = {
  nodeEnv: "test",
  port: 0,
  appOrigin: "http://127.0.0.1:3000",
  apiOrigin: "http://127.0.0.1:3001",
  mongodb: {
    uri: "mongodb://127.0.0.1:27017/real_time_chat_test",
    dbName: "real_time_chat_test",
    connectTimeoutMs: 1_000,
  },
  auth: {
    secret: "synthetic-test-secret-32-characters-minimum",
  },
  ai: {
    provider: "mock",
    model: "mock",
    apiKey: "",
    consentRequired: true,
  },
  turn: {
    urls: ["turns:turn.example.test:5349?transport=tcp"],
    username: "synthetic-turn-user",
    credential: "synthetic-turn-credential",
    realm: "chat.example.test",
    credentialTtlSeconds: 300,
  },
};

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected the test server to bind to an ephemeral TCP port.");
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("HTTP integration boundary", () => {
  it("serves JSON health without disclosing framework headers", async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-powered-by")).toBeNull();
  });

  it("returns 404 for unknown routes and unsupported methods", async () => {
    const unknown = await fetch(`${baseUrl}/unknown`);
    const wrongMethod = await fetch(`${baseUrl}/health`, { method: "POST" });

    expect(unknown.status).toBe(404);
    expect(wrongMethod.status).toBe(404);
  });

  it("keeps app instances isolated", async () => {
    const secondServer = createApp().listen(0);
    await new Promise<void>((resolve, reject) => {
      secondServer.once("listening", resolve);
      secondServer.once("error", reject);
    });

    const address = secondServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the second test server to bind to an ephemeral TCP port.");
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect(response.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => {
        secondServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("AI adapter integration boundary", () => {
  it("selects the network-free mock provider for local development", async () => {
    const provider = createAiProvider(mockConfig);
    const result = await provider.complete({
      operation: "summary",
      input: "Synthetic fixture input.",
    });

    expect(result.provider).toBe("mock");
    expect(result.synthetic).toBe(true);
    expect(result.text).toContain("[mock:summary]");
  });

  it("fails closed for a provider that is not implemented", () => {
    let thrown: unknown;

    try {
      createAiProvider({
        ...mockConfig,
        ai: { ...mockConfig.ai, provider: "groq" },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).issues.join(" ")).toMatch(/not implemented yet/);
  });
});
