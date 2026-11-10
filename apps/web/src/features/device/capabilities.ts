import { detectCryptoCapabilities, type CryptoCapabilityReport } from "@chat/crypto";

/**
 * Browser capability preflight (P2-01). A missing capability blocks device
 * enrollment with an explicit state; there is no plaintext fallback. This is
 * a fail-closed check, not a claim that a particular browser/device is
 * supported (real-browser evidence remains P6-06).
 */
export async function checkDeviceCryptoSupport(): Promise<CryptoCapabilityReport> {
  const report = await detectCryptoCapabilities();
  if (typeof window !== "undefined" && window.isSecureContext !== true) {
    const missing = report.missing.includes("secure-context")
      ? report.missing
      : [...report.missing, "secure-context" as const];
    return { ...report, secureContext: false, ready: false, missing };
  }
  return report;
}

export const DEVICE_CRYPTO_UNAVAILABLE_NOTICE =
  "This browser cannot safely generate and store encryption keys. Device enrollment is unavailable; no plaintext fallback is offered.";
