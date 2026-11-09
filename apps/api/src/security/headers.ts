import type { NextFunction, Request, Response } from "express";

/**
 * HTTP security headers v0 (P1-13, FR-SEC-025).
 * Applied to every API response. The API serves JSON (no HTML), so no
 * Content-Security-Policy is set here; the web app's CSP lives in
 * `apps/web/next.config.ts` headers.
 */
export const API_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
} as const;

export function securityHeadersMiddleware(
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  for (const [name, value] of Object.entries(API_HEADERS)) {
    response.setHeader(name, value);
  }
  next();
}

/** CSP directives the web app must ship (FR-SEC-025). */
export const WEB_CSP_DIRECTIVES: Readonly<Record<string, string>> = {
  "default-src": "'self'",
  "base-uri": "'self'",
  "frame-ancestors": "'none'",
  "form-action": "'self'",
  "object-src": "'none'",
  "img-src": "'self' data:",
};

export function buildWebCsp(apiOrigin: string): string {
  // connect-src allows the exact API origin and same-origin sockets only.
  const connectSrc = `'self' ${apiOrigin}`;
  const parts = [
    `default-src 'self'`,
    `base-uri 'self'`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
    `object-src 'none'`,
    `img-src 'self' data:`,
    `script-src 'self' 'unsafe-inline'`,
    `style-src 'self' 'unsafe-inline'`,
    `connect-src ${connectSrc}`,
  ];
  return parts.join("; ") + ";";
}
