import { loadConfig, loadRootEnvFile } from "../config.js";
import { withMongoClient } from "./mongo.js";
import { runMigrations } from "./migrate.js";
import { reportCliError } from "../dev/cli.js";

/**
 * Apply v0 indexes + migration ledger against the configured database.
 * Local/dev only — refuses production like the seed script.
 */
loadRootEnvFile();

try {
  const config = loadConfig();
  if (config.nodeEnv === "production") {
    throw new Error("Refusing to run migrations while NODE_ENV=production.");
  }
  await withMongoClient(config, async (client) => {
    const result = await runMigrations(client.db(config.mongodb.dbName));
    console.log(
      `Migration v${result.version}: applied=${result.applied} db=${config.mongodb.dbName}`,
    );
  });
} catch (error) {
  reportCliError(error);
  process.exitCode = 1;
}
