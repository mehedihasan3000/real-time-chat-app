import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const template = readFileSync(
  new URL("../../docs/evidence/TEST-EVIDENCE-TEMPLATE.md", import.meta.url),
  "utf8",
);

describe("test evidence template", () => {
  it("captures the tested revision", () => {
    expect(template).toContain("## 2. Tested revision");
    expect(template).toContain("Commit");
    expect(template).toContain("Tree");
    expect(template).toContain("Pull request or review record");
  });

  it("captures the build, configuration, and environment", () => {
    expect(template).toContain("## 3. Environment");
    expect(template).toContain("## 4. Build and configuration");
    expect(template).toContain("Build command");
    expect(template).toContain("Test command");
    expect(template).toContain("E2E command");
    expect(template).toContain("Environment variables");
    expect(template).toContain("Operating system");
    expect(template).toContain("Node.js");
    expect(template).toContain("Browser and version");
  });

  it("captures requirement/test mapping, fixtures, and network profiles", () => {
    expect(template).toContain("Requirement IDs");
    expect(template).toContain("Test IDs");
    expect(template).toContain("Synthetic dataset and fixtures");
    expect(template).toContain("two synthetic participants plus one unrelated user");
    expect(template).toContain("direct / forced relay / lossy relay");
    expect(template).toContain("Real data used");
  });

  it("captures expected/actual results, defects, and reviewer sign-off", () => {
    expect(template).toContain("## 6. Execution results");
    expect(template).toContain("Expected");
    expect(template).toContain("Actual");
    expect(template).toContain("## 8. Defects and limitations");
    expect(template).toContain("## 9. Reviewer sign-off");
    expect(template).toContain("Independent of author");
  });

  it("treats unmeasured thresholds as blocked", () => {
    expect(template).toContain("An unmeasured or unfilled threshold is **blocked**, never passed.");
  });

  it("keeps placeholders instead of invented results", () => {
    expect(template).toContain("<task ID and title>");
    expect(template).toContain("<full commit SHA>");
    expect(template).toContain("<YYYY-MM-DD>");
  });
});
