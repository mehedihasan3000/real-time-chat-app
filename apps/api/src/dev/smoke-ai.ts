import { createAiProvider } from "../ai/index.js";
import { loadConfig, loadRootEnvFile } from "../config.js";
import { reportCliError } from "./cli.js";

loadRootEnvFile();

try {
  const config = loadConfig();
  const provider = createAiProvider(config);
  const result = await provider.complete({
    operation: "smoke",
    input: "Synthetic local smoke test. No real user content.",
  });

  if (!result.synthetic) {
    throw new Error("Expected the local AI mock to mark its response as synthetic.");
  }

  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  reportCliError(error);
  process.exitCode = 1;
}
