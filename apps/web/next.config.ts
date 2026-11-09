import { config as loadEnv } from "dotenv";
import type { NextConfig } from "next";
import { resolve } from "node:path";

// The workspace keeps one local `.env` at the repository root. Next.js runs
// from `apps/web`, so load the shared file before reading public variables.
loadEnv({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const apiOrigin = parseApiOrigin(process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  agentRules: false,
  allowedDevOrigins: ["192.168.0.115"],
  env: {
    NEXT_PUBLIC_API_ORIGIN: apiOrigin,
  },
  // Web client hardening (P1-13, FR-SEC-025): restrictive CSP with exact
  // API connect origin, no third-party scripts, no framing.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: buildWebCsp(apiOrigin),
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};
export default nextConfig;

function buildWebCsp(apiOrigin: string): string {
  return (
    [
      `default-src 'self'`,
      `base-uri 'self'`,
      `frame-ancestors 'none'`,
      `form-action 'self'`,
      `object-src 'none'`,
      `img-src 'self' data:`,
      `script-src 'self' 'unsafe-inline'`,
      `style-src 'self' 'unsafe-inline'`,
      `connect-src 'self' ${apiOrigin}`,
    ].join("; ") + ";"
  );
}

function parseApiOrigin(value: string): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error("NEXT_PUBLIC_API_ORIGIN must be an absolute http(s) URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("NEXT_PUBLIC_API_ORIGIN must use http or https.");
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("NEXT_PUBLIC_API_ORIGIN must not contain credentials.");
  }

  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("NEXT_PUBLIC_API_ORIGIN must be an origin without a path, query, or fragment.");
  }

  return parsed.origin;
}
