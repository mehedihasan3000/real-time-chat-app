import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// `docs/` is git-excluded (local-only), so CI cannot read the local
// runbooks/ADR files. Those assertions run locally and skip in CI;
// the README surface (tracked) is always asserted.
const hasLocalDocs = existsSync("docs/runbooks/README.md");

describe("P1-16 — runbook skeleton covers setup, rollback, incident, key loss", () => {
  it.skipIf(!hasLocalDocs)("runbooks index links every operator runbook", () => {
    const index = readFileSync("docs/runbooks/README.md", "utf8");
    for (const file of [
      "staging-deployment.md",
      "deploy.md",
      "rollback.md",
      "incident.md",
      "key-loss.md",
      "backup-restore.md",
    ]) {
      expect(index, file).toContain(file);
    }
  });

  it.skipIf(!hasLocalDocs)("rollback runbook covers redeploy + re-smoke", () => {
    const text = readFileSync("docs/runbooks/rollback.md", "utf8");
    expect(text).toContain("Roll back");
    expect(text).toContain("Re-run smokes");
    expect(text).toContain("/health");
  });

  it.skipIf(!hasLocalDocs)("incident runbook covers connection, database, AI, and relay", () => {
    const text = readFileSync("docs/runbooks/incident.md", "utf8");
    for (const phrase of [
      "Connection failures",
      "Database incidents",
      "AI outages",
      "Relay failures",
    ]) {
      expect(text).toContain(phrase);
    }
  });

  it.skipIf(!hasLocalDocs)("key-loss runbook never offers a server backdoor", () => {
    const text = readFileSync("docs/runbooks/key-loss.md", "utf8");
    expect(text).toContain("Never offer password-reset-as-recovery");
    expect(text).toContain("256-bit recovery key");
  });

  it("README points new operators at setup and runbooks", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("## Getting started");
    expect(readme).toContain("## Runbooks");
    expect(readme).toContain("rollback.md");
  });

  it.skipIf(!existsSync("docs/adr/README.md"))("ADR index covers all 28 decisions (trace)", () => {
    const index = readFileSync("docs/adr/README.md", "utf8");
    for (let n = 1; n <= 28; n += 1) {
      const id = `DEC-${String(n).padStart(3, "0")}`;
      expect(index.includes(id), id).toBe(true);
    }
  });
});
