import { ConfigError } from "../config.js";

export function reportCliError(error: unknown): void {
  if (error instanceof ConfigError) {
    console.error(error.message);
    for (const issue of error.issues) {
      console.error(`- ${issue}`);
    }
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(redactConnectionStrings(message));
}

function redactConnectionStrings(value: string): string {
  return value.replace(/mongodb(\+srv)?:\/\/[^\s]+/g, "[redacted-mongodb-uri]");
}
