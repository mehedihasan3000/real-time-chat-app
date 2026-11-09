import { createApp } from "./app.js";
import {
  ConfigError,
  describeConfig,
  loadConfig,
  loadRootEnvFile,
  type AppConfig,
} from "./config.js";
import { createVerifier } from "./auth/jwt.js";
import { createSocketServer } from "./socket/index.js";

loadRootEnvFile();

const config = loadRequiredConfig();
// Deployment skeleton (P1-15): the HTTP API and the socket server share
// the same JWKS verifier so staging auth behaves identically.
const verifier = createVerifier({
  appOrigin: config.appOrigin,
  apiOrigin: config.apiOrigin,
  ...(config.auth.jwksUri ? { jwksUri: config.auth.jwksUri } : {}),
});
const app = createApp({ verifier });

const server = app.listen(config.port, () => {
  const summary = describeConfig(config);
  console.log(
    `API listening on http://localhost:${config.port} (env=${summary.nodeEnv}, db=${summary.mongodb.dbName}, ai=${summary.ai.provider})`,
  );
});

// Socket.IO foundation (P1-09) on the same HTTP server (`/v1` namespace).
// JWKS is wired when `JWKS_URI` is set (staging provides the Better Auth
// JWKS endpoint); otherwise verification fails closed. Session/member
// stores fail closed until Mongo wiring lands (GAP-09-01/GAP-15-02);
// the allowed origin is the exact frontend origin only.
// The socket verifier is the same JWKS verifier shared with the HTTP API.
const socketVerifier = verifier;
createSocketServer(server, {
  verifier: socketVerifier,
  sessionLookup: async () => null,
  authorizer: {
    conversationLookup: async () => null,
  },
  allowedOrigins: [config.appOrigin],
});

function loadRequiredConfig(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error("Invalid environment configuration:");
      for (const issue of error.issues) {
        console.error(`- ${issue}`);
      }
      console.error("Copy .env.example to .env and fill in the required local values.");
    } else {
      console.error("Failed to load environment configuration.");
    }

    process.exit(1);
  }
}

function shutdown(signal: string): void {
  console.log(`Received ${signal}; shutting down.`);
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
