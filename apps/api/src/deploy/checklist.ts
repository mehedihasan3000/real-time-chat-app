/**
 * Deployment skeleton checks v0 (P1-15, OPS-001/002/004/010, FR-SEC-018).
 *
 * Pure helpers that the deployment smoke tests assert against
 * `render.yaml`, the staging env template, and the runtime config.
 * Fail-closed: production requires non-local https origins, TLS MongoDB,
 * and non-placeholder secrets (enforced by `config.ts`).
 */

export interface DeployCheck {
  id: string;
  pass: boolean;
  evidence: string;
}

/** Render Blueprint: free plan, Singapore, health path, dev build, sync:false secrets. */
export function checkRenderYaml(text: string): DeployCheck {
  const withoutComments = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  const checks: Array<[string, boolean]> = [
    ["plan free", /plan:\s*free/.test(withoutComments)],
    ["region singapore", /region:\s*singapore/.test(withoutComments)],
    ["health /health", /healthCheckPath:\s*\/health/.test(withoutComments)],
    ["build includes dev", withoutComments.includes("--include=dev")],
    ["secrets sync:false", (withoutComments.match(/sync:\s*false/g) ?? []).length >= 3],
    [
      "no plaintext secret",
      !/sync:\s*false[\s\S]{0,200}(mongodb\+srv:\/\/[^<\s]+:[^<\s]+@)/.test(withoutComments),
    ],
    [
      "STUN-only",
      withoutComments.includes("stun:stun.cloudflare.com:3478") &&
        !withoutComments.includes("TURN_URLS"),
    ],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    id: "RENDER-YAML",
    pass: failed.length === 0,
    evidence:
      failed.length === 0
        ? "free/singapore/health/dev-build/sync-false/STUN-only"
        : `failed: ${failed.join(", ")}`,
  };
}

/** Staging env template: placeholders only, no active credentials. */
export function checkStagingTemplate(text: string): DeployCheck {
  const hasPlaceholders =
    text.includes("<vercel-staging-host>") || text.includes("<render-staging-host>");
  const hasActiveSecret =
    /mongodb\+srv:\/\/[^<\s]+:[^<\s]+@[^\s/]+/.test(text) && !text.includes("<staging-user>");
  return {
    id: "STAGING-TEMPLATE",
    pass: hasPlaceholders && !hasActiveSecret,
    evidence:
      hasPlaceholders && !hasActiveSecret
        ? "placeholders only, no active credentials"
        : "template missing placeholders or contains active secret",
  };
}

/** Environment separation: staging uses its own DB/secrets, never production. */
export function checkEnvSeparation(env: Record<string, string>): DeployCheck {
  const dbName = env.MONGODB_DB ?? "";
  const staging = /staging/.test(dbName);
  const prod = /prod/.test(dbName) || /production/.test(dbName);
  return {
    id: "ENV-SEPARATION",
    pass: staging && !prod,
    evidence: `MONGODB_DB=${staging ? "staging" : "non-staging"}`,
  };
}
