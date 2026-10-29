import { describe, expect, it } from "vitest";
import {
  ConfigError,
  assertSafeSeedTarget,
  describeConfig,
  loadConfig,
} from "../../apps/api/src/config.js";
import { baseEnv, productionEnv } from "../fixtures/env.js";

function load(overrides: Record<string, string | undefined> = {}) {
  return loadConfig({ ...baseEnv, ...overrides });
}

function configError(overrides: Record<string, string | undefined> = {}): ConfigError {
  try {
    load(overrides);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }

  throw new Error("Expected loadConfig to throw ConfigError.");
}

function thrownConfigError(action: () => void): ConfigError {
  try {
    action();
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }

  throw new Error("Expected the action to throw ConfigError.");
}

describe("loadConfig", () => {
  it("applies local defaults", () => {
    const config = load();

    expect(config.nodeEnv).toBe("development");
    expect(config.port).toBe(3001);
    expect(config.appOrigin).toBe("http://localhost:3000");
    expect(config.apiOrigin).toBe("http://localhost:3001");
    expect(config.mongodb).toEqual({
      uri: "mongodb://127.0.0.1:27017/real_time_chat_dev",
      dbName: "real_time_chat_dev",
      connectTimeoutMs: 5000,
    });
    expect(config.auth.secret).toBe("local-dev-only-change-me-32-characters-minimum");
    expect(config.ai).toEqual({
      provider: "mock",
      model: "mock",
      apiKey: "",
      consentRequired: true,
    });
    expect(config.turn).toEqual({
      urls: ["turn:localhost:3478?transport=udp", "turn:localhost:3478?transport=tcp"],
      username: "dev",
      credential: "dev-only-not-a-secret",
      realm: "chat.local",
      credentialTtlSeconds: 7200,
    });
  });

  it("parses explicit local values", () => {
    const config = load({
      NODE_ENV: "test",
      PORT: "8080",
      AI_MODEL: "custom-model",
      AI_CONSENT_REQUIRED: "false",
      TURN_URLS: "turn:a.example.com:3478,turn:b.example.com:3478",
      TURN_CREDENTIAL_TTL_SECONDS: "60",
    });

    expect(config.nodeEnv).toBe("test");
    expect(config.port).toBe(8080);
    expect(config.ai.model).toBe("custom-model");
    expect(config.ai.consentRequired).toBe(false);
    expect(config.turn.urls).toEqual(["turn:a.example.com:3478", "turn:b.example.com:3478"]);
    expect(config.turn.credentialTtlSeconds).toBe(60);
  });

  it("normalizes a valid origin with a trailing slash", () => {
    const config = load({ APP_ORIGIN: "http://localhost:3000/" });

    expect(config.appOrigin).toBe("http://localhost:3000");
  });

  it.each([
    ["not a url", "absolute http(s)"],
    ["ftp://example.com", "http or https"],
    ["http://localhost:3000/path", "origin without a path"],
    ["http://localhost:3000?query=1", "origin without a path"],
    ["http://localhost:3000#hash", "origin without a path"],
    ["http://user:pass@localhost:3000", "origin without a path"],
  ])("rejects APP_ORIGIN=%s", (value, expectedMessage) => {
    const error = configError({ APP_ORIGIN: value });

    expect(error.issues.join("\n")).toContain(expectedMessage);
  });

  it("reports missing required values", () => {
    const error = configError({
      APP_ORIGIN: undefined,
      API_ORIGIN: undefined,
      MONGODB_URI: undefined,
      MONGODB_DB: undefined,
      BETTER_AUTH_SECRET: undefined,
    });

    expect(error.issues.join("\n")).toContain("APP_ORIGIN is required");
    expect(error.issues.join("\n")).toContain("API_ORIGIN is required");
    expect(error.issues.join("\n")).toContain("MONGODB_URI is required");
    expect(error.issues.join("\n")).toContain("MONGODB_DB is required");
    expect(error.issues.join("\n")).toContain("BETTER_AUTH_SECRET is required");
  });

  it("reports a root-level schema issue without a field path", () => {
    try {
      loadConfig(null as unknown as NodeJS.ProcessEnv);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues[0]).toMatch(/^environment:/);
      return;
    }

    throw new Error("Expected loadConfig to throw ConfigError.");
  });

  it("rejects an invalid port", () => {
    expect(configError({ PORT: "0" }).issues.join("\n")).toContain("PORT");
    expect(configError({ PORT: "65536" }).issues.join("\n")).toContain("PORT");
    expect(configError({ PORT: "1.5" }).issues.join("\n")).toContain("PORT");
    expect(configError({ PORT: "not-a-number" }).issues.join("\n")).toContain("PORT");
  });

  it("rejects a malformed MongoDB URI", () => {
    expect(configError({ MONGODB_URI: "http://example.com" }).issues.join("\n")).toContain(
      "MONGODB_URI must be a valid",
    );
    expect(configError({ MONGODB_URI: "mongodb://[" }).issues.join("\n")).toContain(
      "MONGODB_URI must be a valid",
    );
    expect(configError({ MONGODB_URI: "" }).issues.join("\n")).toContain("MONGODB_URI");
  });

  it("accepts an Atlas SRV URI", () => {
    const config = load({
      MONGODB_URI: "mongodb+srv://cluster.example.mongodb.net/?retryWrites=true",
    });

    expect(config.mongodb.uri).toContain("mongodb+srv://");
  });

  it("rejects an invalid database name", () => {
    expect(configError({ MONGODB_DB: "bad database" }).issues.join("\n")).toContain("MONGODB_DB");
  });

  it("rejects a short auth secret", () => {
    expect(configError({ BETTER_AUTH_SECRET: "short" }).issues.join("\n")).toContain(
      "BETTER_AUTH_SECRET must be at least 32 characters",
    );
  });

  it("rejects empty or invalid TURN URLs", () => {
    expect(configError({ TURN_URLS: "" }).issues.join("\n")).toContain("at least one TURN URL");
    expect(configError({ TURN_URLS: "http://turn.example.com" }).issues.join("\n")).toContain(
      "invalid TURN URL",
    );
  });

  it("rejects a non-boolean consent value", () => {
    expect(configError({ AI_CONSENT_REQUIRED: "TRUE" }).issues.join("\n")).toContain(
      "AI_CONSENT_REQUIRED",
    );
  });
});

describe("production configuration", () => {
  it("accepts a production-safe configuration", () => {
    const config = loadConfig(productionEnv);

    expect(config.nodeEnv).toBe("production");
    expect(config.ai.provider).toBe("groq");
    expect(config.turn.urls).toEqual(["turns:turn.example.com:5349?transport=tcp"]);
  });

  it.each([
    ["http://app.example.com", "APP_ORIGIN must be a non-local https origin"],
    ["https://localhost", "APP_ORIGIN must be a non-local https origin"],
    ["https://127.0.0.1", "APP_ORIGIN must be a non-local https origin"],
    ["https://[::1]", "APP_ORIGIN must be a non-local https origin"],
    ["https://app.localhost", "APP_ORIGIN must be a non-local https origin"],
  ])("rejects APP_ORIGIN=%s in production", (value, expectedMessage) => {
    const error = configError({ ...productionEnv, APP_ORIGIN: value });

    expect(error.issues.join("\n")).toContain(expectedMessage);
  });

  it("rejects a local API origin in production", () => {
    expect(
      configError({ ...productionEnv, API_ORIGIN: "https://localhost" }).issues.join("\n"),
    ).toContain("API_ORIGIN must be a non-local https origin");
  });

  it("rejects a non-HTTPS API origin in production", () => {
    expect(
      configError({ ...productionEnv, API_ORIGIN: "http://api.example.com" }).issues.join("\n"),
    ).toContain("API_ORIGIN must be a non-local https origin");
  });

  it("rejects a local MongoDB host in production", () => {
    expect(
      configError({
        ...productionEnv,
        MONGODB_URI: "mongodb://127.0.0.1:27017/real_time_chat_prod",
      }).issues.join("\n"),
    ).toContain("MONGODB_URI must not point at localhost in production");
  });

  it("requires TLS for a non-SRV MongoDB URI in production", () => {
    expect(
      configError({
        ...productionEnv,
        MONGODB_URI: "mongodb://cluster.example.mongodb.net:27017/real_time_chat_prod",
      }).issues.join("\n"),
    ).toContain("MONGODB_URI must enable TLS in production");

    const config = loadConfig({
      ...productionEnv,
      MONGODB_URI: "mongodb://cluster.example.mongodb.net:27017/real_time_chat_prod?tls=true",
    });
    expect(config.mongodb.uri).toContain("tls=true");
  });

  it("rejects the local auth placeholder in production", () => {
    expect(
      configError({
        ...productionEnv,
        BETTER_AUTH_SECRET: "local-dev-only-change-me-32-characters-minimum",
      }).issues.join("\n"),
    ).toContain("BETTER_AUTH_SECRET must not use the local development placeholder");
  });

  it("rejects the AI mock and missing AI key in production", () => {
    expect(configError({ ...productionEnv, AI_PROVIDER: "mock" }).issues.join("\n")).toContain(
      "AI_PROVIDER=mock is not allowed in production",
    );
    expect(configError({ ...productionEnv, AI_API_KEY: "" }).issues.join("\n")).toContain(
      "AI_API_KEY is required",
    );
  });

  it("requires AI consent in production", () => {
    expect(
      configError({ ...productionEnv, AI_CONSENT_REQUIRED: "false" }).issues.join("\n"),
    ).toContain("AI_CONSENT_REQUIRED must be true in production");
  });

  it("rejects local TURN endpoints in production", () => {
    expect(
      configError({
        ...productionEnv,
        TURN_URLS: "turn:localhost:3478?transport=udp",
      }).issues.join("\n"),
    ).toContain("TURN_URLS must not point at localhost in production");
  });

  it.each([
    ["TURN_USERNAME", "dev", "TURN test credentials must not be used in production"],
    [
      "TURN_CREDENTIAL",
      "dev-only-not-a-secret",
      "TURN test credentials must not be used in production",
    ],
    ["TURN_REALM", "chat.local", "TURN test credentials must not be used in production"],
  ])("rejects %s=%s in production", (key, value, expectedMessage) => {
    const error = configError({ ...productionEnv, [key]: value });

    expect(error.issues.join("\n")).toContain(expectedMessage);
  });
});

describe("describeConfig", () => {
  it("redacts credentials and secrets", () => {
    const mongoUri = ["mongodb://", "user", ":", "pass", "@db.example.com:27017/db"].join("");
    const config = load({ MONGODB_URI: mongoUri });
    const summary = describeConfig(config);

    expect(summary.mongodb).toEqual({ dbName: "real_time_chat_dev", host: "db.example.com:27017" });
    expect(summary.auth.secretConfigured).toBe(true);
    expect(JSON.stringify(summary)).not.toContain("user:pass");
    expect(JSON.stringify(summary)).not.toContain("local-dev-only");
    expect(JSON.stringify(summary)).not.toContain("dev-only-not-a-secret");
  });

  it("handles an empty secret and an unparseable host", () => {
    const config = load();
    const summary = describeConfig({
      ...config,
      auth: { secret: "" },
      mongodb: { ...config.mongodb, uri: "mongodb://" },
    });

    expect(summary.auth.secretConfigured).toBe(false);
    expect(summary.mongodb.host).toBe("unknown");
  });

  it("shows a host without credentials", () => {
    const summary = describeConfig(load());

    expect(summary.mongodb.host).toBe("127.0.0.1:27017");
  });
});

describe("assertSafeSeedTarget", () => {
  it.each(["app_dev", "app_local", "app_test", "APP_DEV"])(
    "accepts the development database %s",
    (dbName) => {
      const config = load();
      expect(() =>
        assertSafeSeedTarget({ ...config, mongodb: { ...config.mongodb, dbName } }),
      ).not.toThrow();
    },
  );

  it("rejects a production-like database name", () => {
    const config = load();
    const error = thrownConfigError(() =>
      assertSafeSeedTarget({
        ...config,
        mongodb: { ...config.mongodb, dbName: "real_time_chat" },
      }),
    );

    expect(error.issues.join("\n")).toContain("Refusing to seed database");
  });

  it("rejects seeding while NODE_ENV=production", () => {
    const config = load();
    const error = thrownConfigError(() =>
      assertSafeSeedTarget({ ...config, nodeEnv: "production" }),
    );

    expect(error.issues.join("\n")).toContain("Refusing to seed while NODE_ENV=production");
  });
});
