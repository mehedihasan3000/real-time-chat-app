import { describe, expect, it } from "vitest";
import {
  ConfigError,
  assertSafeSeedTarget,
  buildIceServers,
  describeConfig,
  loadConfig,
} from "../../apps/api/src/config.js";
import { baseEnv, productionEnv, productionTurnEnv } from "../fixtures/env.js";

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
    expect(config.ice).toEqual({
      stunUrls: ["stun:localhost:3478"],
      turn: null,
    });
  });

  it("parses explicit local values", () => {
    const config = load({
      NODE_ENV: "test",
      PORT: "8080",
      AI_MODEL: "custom-model",
      AI_CONSENT_REQUIRED: "false",
      STUN_URLS: "stun:stun.example.com:3478",
      TURN_URLS: "turn:a.example.com:3478,turn:b.example.com:3478",
      TURN_USERNAME: "local-user",
      TURN_CREDENTIAL: "local-credential",
      TURN_REALM: "chat.example.com",
      TURN_CREDENTIAL_TTL_SECONDS: "60",
    });

    expect(config.nodeEnv).toBe("test");
    expect(config.port).toBe(8080);
    expect(config.ai.model).toBe("custom-model");
    expect(config.ai.consentRequired).toBe(false);
    expect(config.ice.stunUrls).toEqual(["stun:stun.example.com:3478"]);
    expect(config.ice.turn).toEqual({
      urls: ["turn:a.example.com:3478", "turn:b.example.com:3478"],
      username: "local-user",
      credential: "local-credential",
      realm: "chat.example.com",
      credentialTtlSeconds: 60,
    });
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

  it("allows a STUN-only configuration without TURN values", () => {
    const config = load({
      TURN_URLS: "",
      TURN_USERNAME: "",
      TURN_CREDENTIAL: "",
      TURN_REALM: "",
    });

    expect(config.ice.stunUrls).toEqual(["stun:localhost:3478"]);
    expect(config.ice.turn).toBeNull();
  });

  it("rejects empty or invalid STUN URLs", () => {
    expect(configError({ STUN_URLS: "" }).issues.join("\n")).toContain("at least one STUN URL");
    expect(configError({ STUN_URLS: "http://stun.example.com" }).issues.join("\n")).toContain(
      "invalid STUN URL",
    );
  });

  it("rejects invalid TURN URLs and incomplete TURN credentials", () => {
    expect(
      configError({
        TURN_URLS: "http://turn.example.com",
        TURN_USERNAME: "local-user",
        TURN_CREDENTIAL: "local-credential",
        TURN_REALM: "chat.example.com",
      }).issues.join("\n"),
    ).toContain("invalid TURN URL");

    expect(
      configError({
        TURN_URLS: "turn:turn.example.com:3478",
        TURN_USERNAME: "",
        TURN_CREDENTIAL: "",
        TURN_REALM: "",
      }).issues.join("\n"),
    ).toContain("TURN_USERNAME is required when TURN_URLS is set");
  });

  it("rejects a non-boolean consent value", () => {
    expect(configError({ AI_CONSENT_REQUIRED: "TRUE" }).issues.join("\n")).toContain(
      "AI_CONSENT_REQUIRED",
    );
  });
});

describe("production configuration", () => {
  it("accepts a production-safe STUN-only configuration", () => {
    const config = loadConfig(productionEnv);

    expect(config.nodeEnv).toBe("production");
    expect(config.ai.provider).toBe("groq");
    expect(config.ice.stunUrls).toEqual(["stun:stun.cloudflare.com:3478"]);
    expect(config.ice.turn).toBeNull();
  });

  it("accepts an optional production TURN configuration", () => {
    const config = loadConfig(productionTurnEnv);

    expect(config.ice.stunUrls).toEqual(["stun:stun.cloudflare.com:3478"]);
    expect(config.ice.turn).toEqual({
      urls: ["turns:turn.example.com:5349?transport=tcp"],
      username: "production-user",
      credential: "test-only-production-credential",
      realm: "chat.example.com",
      credentialTtlSeconds: 7200,
    });
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

  it("rejects a local STUN endpoint in production", () => {
    expect(
      configError({
        ...productionEnv,
        STUN_URLS: "stun:localhost:3478",
      }).issues.join("\n"),
    ).toContain("STUN_URLS must not point at localhost in production");
  });

  it("rejects local TURN endpoints in production", () => {
    expect(
      configError({
        ...productionTurnEnv,
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
    const error = configError({ ...productionTurnEnv, [key]: value });

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

  it("summarizes optional TURN configuration without credentials", () => {
    const config = load({
      TURN_URLS: "turn:turn.example.com:3478",
      TURN_USERNAME: "turn-user",
      TURN_CREDENTIAL: "turn-secret",
      TURN_REALM: "chat.example.com",
    });
    const summary = describeConfig(config);

    expect(summary.ice).toEqual({
      stunUrls: ["stun:localhost:3478"],
      turnConfigured: true,
      turnUrls: ["turn:turn.example.com:3478"],
      turnRealm: "chat.example.com",
      turnCredentialTtlSeconds: 7200,
    });
    expect(JSON.stringify(summary)).not.toContain("turn-user");
    expect(JSON.stringify(summary)).not.toContain("turn-secret");
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

describe("buildIceServers", () => {
  it("returns STUN only by default", () => {
    expect(buildIceServers(load())).toEqual([{ urls: ["stun:localhost:3478"] }]);
  });

  it("adds TURN when TURN_URLS is configured", () => {
    const config = load({
      TURN_URLS: "turn:turn.example.com:3478",
      TURN_USERNAME: "turn-user",
      TURN_CREDENTIAL: "turn-secret",
      TURN_REALM: "chat.example.com",
    });

    expect(buildIceServers(config)).toEqual([
      { urls: ["stun:localhost:3478"] },
      {
        urls: ["turn:turn.example.com:3478"],
        username: "turn-user",
        credential: "turn-secret",
      },
    ]);
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
