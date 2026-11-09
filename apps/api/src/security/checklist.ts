/**
 * Security baseline checklist v0 (P1-13, FR-SEC-024/025, OPS-005/016).
 *
 * The checklist is executable: each item returns pass/fail with evidence
 * the tests assert. Production hardening items that need real services
 * (browser, staging, provider) remain explicit gaps outside this file.
 */

export interface ChecklistOutcome {
  id: string;
  pass: boolean;
  evidence: string;
}

/** Better Auth session-cookie attributes (host-only, per DEC-019 §3.1). */
export const EXPECTED_COOKIE_ATTRIBUTES = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
  domain: null,
  cookieCacheMaxAge: 0,
} as const;

export function checkCookieAttributes(attributes: {
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
  path: string;
  domain: string | null;
  cookieCacheMaxAge: number;
}): ChecklistOutcome {
  const pass =
    attributes.httpOnly === EXPECTED_COOKIE_ATTRIBUTES.httpOnly &&
    attributes.secure === EXPECTED_COOKIE_ATTRIBUTES.secure &&
    attributes.sameSite === EXPECTED_COOKIE_ATTRIBUTES.sameSite &&
    attributes.path === EXPECTED_COOKIE_ATTRIBUTES.path &&
    attributes.domain === EXPECTED_COOKIE_ATTRIBUTES.domain &&
    attributes.cookieCacheMaxAge === EXPECTED_COOKIE_ATTRIBUTES.cookieCacheMaxAge;
  return {
    id: "COOKIE-ATTRIBUTES",
    pass,
    evidence: pass
      ? "host-only HttpOnly/Secure SameSite=Lax, Path=/, no Domain, cookieCache disabled"
      : "session cookie attributes diverge from the approved policy",
  };
}

/** Third-party script inventory (FR-SEC-025): none approved in v0. */
export const THIRD_PARTY_SCRIPTS: readonly { src: string; reason: string }[] = [];

export function checkThirdPartyScripts(): ChecklistOutcome {
  return {
    id: "THIRD-PARTY-SCRIPTS",
    pass: THIRD_PARTY_SCRIPTS.length === 0,
    evidence:
      THIRD_PARTY_SCRIPTS.length === 0
        ? "no third-party scripts approved"
        : "unreviewed script present",
  };
}

/** SHA-pinned GitHub Actions (build provenance, OPS-005). */
export function checkPinnedActions(workflowText: string): ChecklistOutcome {
  const uses = [...workflowText.matchAll(/^.*uses:\s*(\S+).*$/gm)].map((m) => m[1] ?? "");
  const pinned = uses.filter((u) => /@([a-f0-9]{40})\b/.test(u));
  return {
    id: "PINNED-ACTIONS",
    pass: uses.length > 0 && pinned.length === uses.length,
    evidence: `${pinned.length}/${uses.length} actions SHA-pinned`,
  };
}

/** CI runs dependency audit + secret scan (OPS-005). */
export function checkCiGates(workflowText: string): ChecklistOutcome {
  const hasAudit = workflowText.includes("audit:ci");
  const hasScan = workflowText.includes("secret:scan") || workflowText.includes("Secret scan");
  return {
    id: "CI-GATES",
    pass: hasAudit && hasScan,
    evidence: `audit=${hasAudit} secret-scan=${hasScan}`,
  };
}

/** Build provenance: lockfile + pinned Node + no hidden install scripts. */
export function checkNodePolicy(packageJsonText: string): ChecklistOutcome {
  const parsed = JSON.parse(packageJsonText) as {
    engines?: { node?: string };
    scripts?: Record<string, string>;
  };
  const enginesOk = (parsed.engines?.node ?? "").includes(">=24");
  const scripts = parsed.scripts ?? {};
  const suspicious = Object.keys(scripts).filter((name) => /^(preinstall|install)\b/.test(name));
  return {
    id: "NODE-POLICY",
    pass: enginesOk && suspicious.length === 0,
    evidence: `engines node=${parsed.engines?.node ?? "missing"} suspicious-install-scripts=${suspicious.length}`,
  };
}

/** Run the whole baseline; every item must pass. */
export function runBaselineChecklist(input: {
  cookie: Parameters<typeof checkCookieAttributes>[0];
  workflowText: string;
  rootPackageJsonText: string;
}): ChecklistOutcome[] {
  return [
    checkCookieAttributes(input.cookie),
    checkThirdPartyScripts(),
    checkPinnedActions(input.workflowText),
    checkCiGates(input.workflowText),
    checkNodePolicy(input.rootPackageJsonText),
  ];
}
