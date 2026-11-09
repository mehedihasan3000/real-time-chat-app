import type { NextFunction, Request, Response } from "express";

import { isRequestId, newRequestId } from "@chat/contracts";

import { createLogger } from "./logger.js";
import { MetricsRegistry, statusClass } from "./metrics.js";

export interface RequestWithId extends Request {
  requestId?: string;
}

/**
 * Correlation-ID + structured logging middleware (P1-12, ERR-001).
 *
 * - Takes a valid client `X-Request-Id` (UUID) verbatim, else generates
 *   one; echoes it on the response header and into every log line.
 * - Logs one info/error line per request (route TEMPLATE, never the raw
 *   path with IDs, never bodies/headers/tokens).
 */
export function correlationMiddleware(registry: MetricsRegistry, logger = createLogger()) {
  return (request: RequestWithId, response: Response, next: NextFunction): void => {
    const incoming = request.headers["x-request-id"];
    const requestId =
      typeof incoming === "string" && isRequestId(incoming) ? incoming : newRequestId();
    request.requestId = requestId;
    response.setHeader("X-Request-Id", requestId);

    const startedAt = Date.now();
    response.on("finish", () => {
      const durationMs = Date.now() - startedAt;
      const status = response.statusCode;
      registry.inc("http_requests_total", {
        component: "http",
        method: request.method,
        statusClass: statusClass(status),
      });
      registry.observeDuration("http_request_duration_ms", durationMs, {
        component: "http",
        method: request.method,
        statusClass: statusClass(status),
      });
      const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
      logger.log(level, "http", {
        requestId,
        method: request.method,
        route: request.route?.path ? String(request.route.path) : request.path,
        status,
        durationMs,
      });
    });

    next();
  };
}

/** Socket activity counters (OPS-011): connections/reconnects, no content. */
export function recordSocketMetric(
  registry: MetricsRegistry,
  name: "socket_connections_total" | "socket_reconnects_total" | "socket_events_total",
): void {
  registry.inc(name, { component: "socket" });
}
