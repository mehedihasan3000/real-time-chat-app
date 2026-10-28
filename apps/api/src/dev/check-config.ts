import { describeConfig, loadConfig, loadRootEnvFile } from "../config.js";
import { reportCliError } from "./cli.js";

loadRootEnvFile();

try {
  const config = loadConfig();
  console.log(JSON.stringify(describeConfig(config), null, 2));
} catch (error) {
  reportCliError(error);
  process.exitCode = 1;
}
