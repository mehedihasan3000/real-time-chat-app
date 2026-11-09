import { redactClientObject } from "./redact.js";

/**
 * Browser error reporter v0 (P1-12, TC-ERR-001).
 *
 * Reports only the stable error `code`, correlation `requestId`, and the
 * client route — never message bodies, tokens, or raw provider text.
 * Errors carry safe localized guidance via the shared error-code table;
 * this reporter is the sink-side scrub for any future telemetry transport
 * (P6-06), which must keep the same redaction contract.
 */
export interface ClientErrorReport {
  code: string;
  requestId?: string;
  route?: string;
}

export function reportClientError(
  report: ClientErrorReport,
  sink: (line: string) => void = (line) => {
    console.error(line);
  },
): void {
  const safe = redactClientObject({
    level: "error",
    component: "web",
    code: report.code,
    requestId: report.requestId,
    route: report.route,
  }) as Record<string, unknown>;
  sink(JSON.stringify(safe));
}
