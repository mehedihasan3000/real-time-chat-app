import { redactObject } from "./redact.js";

/**
 * Structured JSON logger v0 (P1-12, OPS-011 / NFR-MAINT-002).
 *
 * One JSON object per line on stdout (or an injected sink for tests).
 * Every entry carries a correlation `requestId` when available, and all
 * fields pass through the redaction baseline — so a caller bug that
 * accidentally includes a token or message body still cannot leak it.
 */
export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  requestId?: string;
  message?: string;
  code?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  [key: string]: unknown;
}

export type LogSink = (line: string) => void;

const defaultSink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

export interface Logger {
  log(
    level: LogLevel,
    component: string,
    fields: Omit<LogEntry, "timestamp" | "level" | "component">,
  ): void;
  info(component: string, fields?: Partial<LogEntry>): void;
  warn(component: string, fields?: Partial<LogEntry>): void;
  error(component: string, fields?: Partial<LogEntry>): void;
}

export function createLogger(sink: LogSink = defaultSink): Logger {
  const emit = (level: LogLevel, component: string, fields: Partial<LogEntry> = {}): void => {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      ...fields,
    };
    const safe = redactObject(entry) as LogEntry;
    sink(JSON.stringify(safe));
  };
  return {
    log: (level, component, fields) => emit(level, component, fields),
    info: (component, fields) => emit("info", component, fields),
    warn: (component, fields) => emit("warn", component, fields),
    error: (component, fields) => emit("error", component, fields),
  };
}
