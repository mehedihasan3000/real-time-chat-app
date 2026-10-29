import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const contractsSource = fileURLToPath(
  new URL("./packages/contracts/src/index.ts", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      "@chat/contracts": contractsSource,
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    reporters: ["default", "junit"],
    outputFile: {
      junit: "./reports/junit.xml",
    },
    coverage: {
      provider: "v8",
      include: [
        "apps/api/src/app.ts",
        "apps/api/src/ai/index.ts",
        "apps/api/src/ai/mock.ts",
        "apps/api/src/config.ts",
        "packages/contracts/src/index.ts",
      ],
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 70,
        statements: 70,
      },
    },
  },
});
