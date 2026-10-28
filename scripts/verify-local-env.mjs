import { spawnSync } from "node:child_process";

const steps = ["config:check", "db:check", "seed", "smoke:ai"];
const npmCli = process.env.npm_execpath;
const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";

for (const step of steps) {
  console.log(`\n==> npm run ${step}`);
  const args = npmCli ? [npmCli, "run", step] : ["run", step];
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: !npmCli && process.platform === "win32",
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`Local environment verification failed at: ${step}`);
    process.exit(result.status ?? 1);
  }
}

console.log("\nLocal environment verification passed.");
