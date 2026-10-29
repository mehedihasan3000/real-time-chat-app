import { describe, expect, it } from "vitest";
import { scanRepository, scanText } from "../../scripts/secret-scan.mjs";

const fakePrivateKey = ["-----BEGIN ", "PRIVATE KEY", "-----"].join("");
const fakeGithubToken = ["ghp_", "A".repeat(36)].join("");
const fakeAwsKey = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
const fakeMongoUri = ["mongodb://", "user", ":", "pass", "@db.internal:27017/app"].join("");
const fakeGenericSecret = ["api_key = ", '"', "AbCdEf0123456789AbCdEf0123456789", '"'].join("");

describe("scanText", () => {
  it("detects high-confidence secret patterns", () => {
    expect(scanText(fakePrivateKey, "key.txt")).toEqual([
      { file: "key.txt", line: 1, rule: "private-key" },
    ]);
    expect(scanText(fakeGithubToken, "token.txt")[0]?.rule).toBe("github-token");
    expect(scanText(fakeAwsKey, "aws.txt")[0]?.rule).toBe("aws-access-key");
    expect(scanText(fakeMongoUri, "mongo.txt")[0]?.rule).toBe("mongodb-credentials");
    expect(scanText(fakeGenericSecret, "config.txt")[0]?.rule).toBe("generic-secret");
  });

  it("reports the line number of a finding", () => {
    const findings = scanText(`line one\nline two\n${fakeGithubToken}\n`, "token.txt");

    expect(findings[0]?.line).toBe(3);
  });

  it("allows documented local placeholders", () => {
    expect(scanText("BETTER_AUTH_SECRET=local-dev-only-change-me-32-characters-minimum")).toEqual(
      [],
    );
    expect(
      scanText("MONGODB_URI=mongodb+srv://<dev-user>:<dev-password>@cluster.example.mongodb.net/"),
    ).toEqual([]);
    expect(scanText("TURN_CREDENTIAL=dev-only-not-a-secret")).toEqual([]);
    expect(scanText("AI_API_KEY=synthetic-test-key")).toEqual([]);
  });

  it("does not flag ordinary text", () => {
    expect(scanText("The quick brown fox jumps over the lazy dog.")).toEqual([]);
  });
});

describe("scanRepository", () => {
  it("passes on the current tracked tree", () => {
    const result = scanRepository({ cwd: process.cwd() });

    expect(result.findings).toEqual([]);
    expect(result.filesChecked).toBeGreaterThan(0);
  });
});
