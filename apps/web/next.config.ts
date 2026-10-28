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
  env: {
    NEXT_PUBLIC_API_ORIGIN: apiOrigin,
  },
};

export default nextConfig;

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
