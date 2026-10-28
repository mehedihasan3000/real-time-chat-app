import { loadConfig, loadRootEnvFile } from "../config.js";
import { pingMongo } from "../db/mongo.js";
import { reportCliError } from "./cli.js";

loadRootEnvFile();

try {
  const config = loadConfig();
  const result = await pingMongo(config);
  console.log(`MongoDB ping succeeded: db=${result.dbName}, latency=${result.latencyMs}ms`);
} catch (error) {
  reportCliError(error);
  process.exitCode = 1;
}
