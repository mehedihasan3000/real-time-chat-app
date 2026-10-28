import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Load the repository-root `.env` file for local development.
 *
 * The file is intentionally optional: production deployments provide
 * configuration through the platform secret store. Values already present in
 * the process environment always win over the file.
 */
export function loadRootEnvFile(): void {
  loadEnv({
    path: fileURLToPath(new URL("../../../.env", import.meta.url)),
    quiet: true,
  });
}

const DEV_AUTH_SECRET = "local-dev-only-change-me-32-characters-minimum";
const DEV_TURN_USERNAME = "dev";
const DEV_TURN_CREDENTIAL = "dev-only-not-a-secret";
const DEV_TURN_REALM = "chat.local";

const originSchema = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .trim()
    .min(1, `${name} is required`)
    .transform((value, context) => {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        context.addIssue({
          code: "custom",
          message: `${name} must be an absolute http(s) URL`,
        });
        return z.NEVER;
      }

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        context.addIssue({
          code: "custom",
          message: `${name} must use http or https`,
        });
        return z.NEVER;
      }

      if (
        parsed.pathname !== "/" ||
        parsed.search !== "" ||
        parsed.hash !== "" ||
        parsed.username !== "" ||
        parsed.password !== ""
      ) {
        context.addIssue({
          code: "custom",
          message: `${name} must be an origin without a path, query, credentials, or fragment`,
        });
        return z.NEVER;
      }

      return parsed.origin;
    });

const mongoUriSchema = z
  .string({ error: "MONGODB_URI is required" })
  .trim()
  .min(1, "MONGODB_URI is required")
  .refine((value) => {
    if (value.length === 0) {
      return true;
    }

    if (!/^mongodb(\+srv)?:\/\//.test(value)) {
      return false;
    }

    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }, "MONGODB_URI must be a valid mongodb:// or mongodb+srv:// connection string");

const turnUrlsSchema = z
  .string()
  .trim()
  .default("turn:localhost:3478?transport=udp,turn:localhost:3478?transport=tcp")
  .transform((value, context) => {
    const urls = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (urls.length === 0) {
      context.addIssue({
        code: "custom",
        message: "TURN_URLS must contain at least one TURN URL",
      });
      return z.NEVER;
    }

    for (const url of urls) {
      if (!/^turns?:[^,\s]+$/.test(url)) {
        context.addIssue({
          code: "custom",
          message: "TURN_URLS contains an invalid TURN URL",
        });
        return z.NEVER;
      }
    }

    return urls;
  });

const booleanSchema = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((value) => value === "true");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  APP_ORIGIN: originSchema("APP_ORIGIN"),
  API_ORIGIN: originSchema("API_ORIGIN"),
  MONGODB_URI: mongoUriSchema,
  MONGODB_DB: z
    .string({ error: "MONGODB_DB is required" })
    .trim()
    .regex(
      /^[A-Za-z0-9_-]{1,63}$/,
      "MONGODB_DB must contain only letters, digits, underscores, or hyphens",
    ),
  MONGODB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(5000),
  BETTER_AUTH_SECRET: z
    .string({ error: "BETTER_AUTH_SECRET is required" })
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  AI_PROVIDER: z.enum(["mock", "groq"]).default("mock"),
  AI_MODEL: z.string().trim().min(1).default("mock"),
  AI_API_KEY: z.string().default(""),
  AI_CONSENT_REQUIRED: booleanSchema("true"),
  TURN_URLS: turnUrlsSchema,
  TURN_USERNAME: z.string().trim().min(1).default(DEV_TURN_USERNAME),
  TURN_CREDENTIAL: z.string().min(1).default(DEV_TURN_CREDENTIAL),
  TURN_REALM: z.string().trim().min(1).default(DEV_TURN_REALM),
  TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(60).max(7200).default(7200),
});

export type NodeEnvironment = "development" | "test" | "production";
export type AiProviderName = "mock" | "groq";

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  port: number;
  appOrigin: string;
  apiOrigin: string;
  mongodb: {
    uri: string;
    dbName: string;
    connectTimeoutMs: number;
  };
  auth: {
    secret: string;
  };
  ai: {
    provider: AiProviderName;
    model: string;
    apiKey: string;
    consentRequired: boolean;
  };
  turn: {
    urls: string[];
    username: string;
    credential: string;
    realm: string;
    credentialTtlSeconds: number;
  };
}

export interface ConfigSummary {
  nodeEnv: NodeEnvironment;
  port: number;
  appOrigin: string;
  apiOrigin: string;
  mongodb: {
    dbName: string;
    host: string;
  };
  auth: {
    secretConfigured: boolean;
  };
  ai: {
    provider: AiProviderName;
    model: string;
    consentRequired: boolean;
  };
  turn: {
    urls: string[];
    realm: string;
    credentialTtlSeconds: number;
  };
}

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super("Invalid environment configuration.");
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(environment);

  if (!result.success) {
    throw new ConfigError(formatIssues(result.error));
  }

  const config: AppConfig = {
    nodeEnv: result.data.NODE_ENV,
    port: result.data.PORT,
    appOrigin: result.data.APP_ORIGIN,
    apiOrigin: result.data.API_ORIGIN,
    mongodb: {
      uri: result.data.MONGODB_URI,
      dbName: result.data.MONGODB_DB,
      connectTimeoutMs: result.data.MONGODB_CONNECT_TIMEOUT_MS,
    },
    auth: {
      secret: result.data.BETTER_AUTH_SECRET,
    },
    ai: {
      provider: result.data.AI_PROVIDER,
      model: result.data.AI_MODEL,
      apiKey: result.data.AI_API_KEY,
      consentRequired: result.data.AI_CONSENT_REQUIRED,
    },
    turn: {
      urls: result.data.TURN_URLS,
      username: result.data.TURN_USERNAME,
      credential: result.data.TURN_CREDENTIAL,
      realm: result.data.TURN_REALM,
      credentialTtlSeconds: result.data.TURN_CREDENTIAL_TTL_SECONDS,
    },
  };

  const productionIssues = validateProductionConfig(config);
  if (productionIssues.length > 0) {
    throw new ConfigError(productionIssues);
  }

  return config;
}

export function describeConfig(config: AppConfig): ConfigSummary {
  return {
    nodeEnv: config.nodeEnv,
    port: config.port,
    appOrigin: config.appOrigin,
    apiOrigin: config.apiOrigin,
    mongodb: {
      dbName: config.mongodb.dbName,
      host: safeMongoHost(config.mongodb.uri),
    },
    auth: {
      secretConfigured: config.auth.secret.length > 0,
    },
    ai: {
      provider: config.ai.provider,
      model: config.ai.model,
      consentRequired: config.ai.consentRequired,
    },
    turn: {
      urls: config.turn.urls,
      realm: config.turn.realm,
      credentialTtlSeconds: config.turn.credentialTtlSeconds,
    },
  };
}

/**
 * Guard destructive local tooling from touching a production-like database.
 * The seed script only writes synthetic fixtures and must remain local.
 */
export function assertSafeSeedTarget(config: AppConfig): void {
  if (config.nodeEnv === "production") {
    throw new ConfigError(["Refusing to seed while NODE_ENV=production."]);
  }

  if (!/(_dev|_local|_test)$/i.test(config.mongodb.dbName)) {
    throw new ConfigError([
      `Refusing to seed database "${config.mongodb.dbName}"; local seeds require a name ending in _dev, _local, or _test.`,
    ]);
  }
}

function validateProductionConfig(config: AppConfig): string[] {
  if (config.nodeEnv !== "production") {
    return [];
  }

  const issues: string[] = [];
  const appOrigin = new URL(config.appOrigin);
  const apiOrigin = new URL(config.apiOrigin);
  const mongoUri = new URL(config.mongodb.uri);

  if (appOrigin.protocol !== "https:" || isLocalHostname(appOrigin.hostname)) {
    issues.push("APP_ORIGIN must be a non-local https origin in production.");
  }

  if (apiOrigin.protocol !== "https:" || isLocalHostname(apiOrigin.hostname)) {
    issues.push("API_ORIGIN must be a non-local https origin in production.");
  }

  if (isLocalHostname(mongoUri.hostname)) {
    issues.push("MONGODB_URI must not point at localhost in production.");
  }

  if (
    config.mongodb.uri.startsWith("mongodb://") &&
    mongoUri.searchParams.get("tls") !== "true" &&
    mongoUri.searchParams.get("ssl") !== "true"
  ) {
    issues.push("MONGODB_URI must enable TLS in production.");
  }

  if (config.auth.secret === DEV_AUTH_SECRET) {
    issues.push("BETTER_AUTH_SECRET must not use the local development placeholder in production.");
  }

  if (config.ai.provider === "mock") {
    issues.push("AI_PROVIDER=mock is not allowed in production.");
  }

  if (config.ai.apiKey.length === 0) {
    issues.push("AI_API_KEY is required when AI is enabled in production.");
  }

  if (!config.ai.consentRequired) {
    issues.push("AI_CONSENT_REQUIRED must be true in production.");
  }

  for (const turnUrl of config.turn.urls) {
    const host =
      turnUrl
        .replace(/^turns?:/, "")
        .split("?")[0]
        ?.split(":")[0] ?? "";
    if (isLocalHostname(host)) {
      issues.push("TURN_URLS must not point at localhost in production.");
      break;
    }
  }

  if (
    config.turn.username === DEV_TURN_USERNAME ||
    config.turn.credential === DEV_TURN_CREDENTIAL ||
    config.turn.realm === DEV_TURN_REALM
  ) {
    issues.push("TURN test credentials must not be used in production.");
  }

  return issues;
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "environment";
    return `${path}: ${issue.message}`;
  });
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost")
  );
}

function safeMongoHost(uri: string): string {
  const withoutScheme = uri.replace(/^mongodb(\+srv)?:\/\//, "");
  const authority = withoutScheme.split(/[/?]/)[0] ?? "";
  const host = authority.includes("@") ? authority.split("@").pop() : authority;
  return host && host.length > 0 ? host : "unknown";
}
