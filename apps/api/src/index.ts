import { createApp } from "./app.js";
import {
  ConfigError,
  describeConfig,
  loadConfig,
  loadRootEnvFile,
  type AppConfig,
} from "./config.js";

loadRootEnvFile();

const config = loadRequiredConfig();
const app = createApp();

const server = app.listen(config.port, () => {
  const summary = describeConfig(config);
  console.log(
    `API listening on http://localhost:${config.port} (env=${summary.nodeEnv}, db=${summary.mongodb.dbName}, ai=${summary.ai.provider})`,
  );
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
