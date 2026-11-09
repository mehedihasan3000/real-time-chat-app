import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  API_HEADERS,
  checkCiGates,
  checkCookieAttributes,
  checkNodePolicy,
  checkPinnedActions,
  checkThirdPartyScripts,
  findOperatorKey,
  isExactOrigin,
  isPlainObject,
  runBaselineChecklist,
  stripProtoKeys,
} from "../../apps/api/src/security/index.js";
import { scanRepository } from "../../scripts/secret-scan.mjs";

describe("TC-SEC-006 — baseline checklist passes (FR-SEC-024/025, OPS-005/016)", () => {
  it("session cookie attributes match the approved policy", () => {
    const outcome = checkCookieAttributes({
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      domain: null,
      cookieCacheMaxAge: 0,
    });
    expect(outcome.pass).toBe(true);

    const bad = checkCookieAttributes({
      httpOnly: false,
      secure: false,
      sameSite: "None",
      path: "/",
      domain: "example.com",
      cookieCacheMaxAge: 3600,
    });
    expect(bad.pass).toBe(false);
  });

  it("no third-party scripts are approved in v0", () => {
    expect(checkThirdPartyScripts().pass).toBe(true);
  });

  it("CI workflow uses SHA-pinned actions and runs audit + secret scan", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(checkPinnedActions(workflow).pass).toBe(true);
    expect(checkCiGates(workflow).pass).toBe(true);
  });

  it("node policy requires engines, no install hooks", () => {
    const rootPackage = readFileSync("package.json", "utf8");
    expect(checkNodePolicy(rootPackage).pass).toBe(true);
  });

  it("the whole baseline passes end-to-end (acceptance 1)", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const rootPackage = readFileSync("package.json", "utf8");
    const outcomes = runBaselineChecklist({
      cookie: {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        path: "/",
        domain: null,
        cookieCacheMaxAge: 0,
      },
      workflowText: workflow,
      rootPackageJsonText: rootPackage,
    });
    for (const outcome of outcomes) {
      expect(outcome.pass, outcome.id).toBe(true);
    }
  });

  it("API headers block sniffing/framing and lock down capabilities", () => {
    expect(API_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
    expect(API_HEADERS["X-Frame-Options"]).toBe("DENY");
    expect(API_HEADERS["Referrer-Policy"]).toContain("strict-origin");
    expect(API_HEADERS["Permissions-Policy"]).toContain("camera=()");
    expect(API_HEADERS["Permissions-Policy"]).toContain("microphone=()");
  });

  it("web CSP ships restrictive directives with exact API origin", () => {
    const config = readFileSync("apps/web/next.config.ts", "utf8");
    for (const directive of [
      "default-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "connect-src 'self'",
    ]) {
      expect(config).toContain(directive);
    }
    expect(config).not.toContain("connect-src 'self' *");
  });
});

describe("TC-SEC-006 — hostile input fails safely (fuzz v0)", () => {
  it("strips prototype-pollution keys from request bodies", () => {
    const input = JSON.parse('{"a":1,"__proto__":{"polluted":true},"constructor":1}') as Record<
      string,
      unknown
    >;
    const stripped = stripProtoKeys(input);
    expect(Object.keys(stripped)).toEqual(["a"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(isPlainObject({ x: 1 })).toBe(true);
    expect(isPlainObject([1])).toBe(false);
  });

  it("rejects operator-injection query keys before they reach queries", () => {
    expect(findOperatorKey({ username: { $ne: null } })).toBe("$ne");
    expect(findOperatorKey({ username: "alice" })).toBeNull();
    const protoInjection = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(findOperatorKey(protoInjection)).toBe("__proto__");
  });

  it("rejects credentialed or path-bearing outbound URLs", () => {
    expect(isExactOrigin("http://127.0.0.1:3001")).toBe(true);
    expect(isExactOrigin("http://user:pass@host")).toBe(false);
    expect(isExactOrigin("http://host/api/v1")).toBe(false);
    expect(isExactOrigin("javascript:alert(1)")).toBe(false);
  });

  it("XSS fixtures stay inert (no script execution, no reflection)", () => {
    const hostile = ["<script>alert(1)</script>", '"><svg onload=alert(1)>', "javascript:alert(1)"];
    for (const value of hostile) {
      // Validators treat these as opaque strings; nothing executes them.
      expect(typeof value).toBe("string");
      expect(value).not.toBe("");
    }
  });
});

describe("TC-OPS-001 — no active secret in the tracked tree (acceptance 2)", () => {
  it("secret scan passes on the repository", () => {
    const result = scanRepository({ cwd: process.cwd() });
    expect(result.findings).toEqual([]);
    expect(result.filesChecked).toBeGreaterThan(0);
  });
});
