/**
 * Browser/device capability preflight (P2-01, DEC-009).
 *
 * Tier A requires a secure context, Web Crypto, IndexedDB, Web Locks, and
 * WebAssembly. P2-01 additionally probes Ed25519 and X25519 for the
 * provisional `dev-webcrypto-v0` identity provider. This is a fail-closed
 * preflight, not a browser-support claim: real Olm/vodozemac integration and
 * real-browser evidence remain P2-02 / P6-06.
 */

export type CryptoCapability =
  | "secure-context"
  | "web-crypto"
  | "indexeddb"
  | "web-locks"
  | "webassembly"
  | "ed25519"
  | "x25519";

export interface CryptoCapabilityReport {
  secureContext: boolean;
  webCrypto: boolean;
  indexedDb: boolean;
  webLocks: boolean;
  webAssembly: boolean;
  ed25519: boolean;
  x25519: boolean;
  ready: boolean;
  missing: CryptoCapability[];
  provisional: true;
  protocol: "dev-webcrypto-v0";
}

/**
 * Narrow environment surface so tests can exercise capability branches
 * without pretending to be a real browser.
 */
export interface CryptoEnvironment {
  crypto?: { subtle?: SubtleCrypto };
  indexedDB?: unknown;
  navigator?: { locks?: unknown };
  WebAssembly?: unknown;
  isSecureContext?: boolean;
}

export const CRYPTO_PROVISIONAL_NOTICE =
  "Provisional dev-webcrypto-v0 identity provider; not an Olm implementation and not an E2EE claim.";

export class CryptoCapabilityError extends Error {
  readonly missing: CryptoCapability[];

  constructor(missing: CryptoCapability[]) {
    super(
      missing.length > 0
        ? `This browser lacks required secure-device capabilities: ${missing.join(", ")}.`
        : "Secure-device capabilities are unavailable.",
    );
    this.name = "CryptoCapabilityError";
    this.missing = missing;
  }
}

async function probeAlgorithm(
  subtle: SubtleCrypto | undefined,
  name: "Ed25519" | "X25519",
  usages: readonly KeyUsage[],
): Promise<boolean> {
  if (!subtle) return false;
  try {
    await subtle.generateKey({ name }, false, usages);
    return true;
  } catch {
    return false;
  }
}

export async function detectCryptoCapabilities(
  environment?: CryptoEnvironment,
): Promise<CryptoCapabilityReport> {
  const env = (environment ?? (globalThis as unknown as CryptoEnvironment)) as CryptoEnvironment;
  const subtle = env.crypto?.subtle;
  const secureContext = env.isSecureContext ?? true;
  const webCrypto = Boolean(subtle);
  const indexedDb = Boolean(env.indexedDB);
  const webLocks = Boolean(env.navigator?.locks);
  const webAssembly = Boolean(env.WebAssembly);
  const ed25519 = await probeAlgorithm(subtle, "Ed25519", ["sign", "verify"]);
  const x25519 = await probeAlgorithm(subtle, "X25519", ["deriveBits"]);

  const missing: CryptoCapability[] = [];
  if (!secureContext) missing.push("secure-context");
  if (!webCrypto) missing.push("web-crypto");
  if (!indexedDb) missing.push("indexeddb");
  if (!webLocks) missing.push("web-locks");
  if (!webAssembly) missing.push("webassembly");
  if (!ed25519) missing.push("ed25519");
  if (!x25519) missing.push("x25519");

  return {
    secureContext,
    webCrypto,
    indexedDb,
    webLocks,
    webAssembly,
    ed25519,
    x25519,
    ready: missing.length === 0,
    missing,
    provisional: true,
    protocol: "dev-webcrypto-v0",
  };
}

export async function assertCryptoReady(
  environment?: CryptoEnvironment,
): Promise<CryptoCapabilityReport> {
  const report = await detectCryptoCapabilities(environment);
  if (!report.ready) throw new CryptoCapabilityError(report.missing);
  return report;
}
