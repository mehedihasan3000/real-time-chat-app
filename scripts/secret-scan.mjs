#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_FILE_BYTES = 1024 * 1024;

const ALLOWLIST = [
  /local-dev/i,
  /dev-only/i,
  /change-me/i,
  /placeholder/i,
  /<[^>]+>/,
  /example/i,
  /test-only/i,
  /not-a-secret/i,
  /synthetic/i,
  /not-a-real/i,
];

const RULES = [
  {
    name: "private-key",
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  },
  {
    name: "mongodb-credentials",
    pattern: /mongodb(?:\+srv)?:\/\/[^/\s:@]+:[^/\s@]+@/g,
  },
  {
    name: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  {
    name: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    name: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    name: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    name: "openai-key",
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/g,
  },
  {
    name: "generic-secret",
    pattern:
      /(?:password|passwd|secret|token|api[_-]?key|credential)[ \t]*[:=][ \t]*["']?([A-Za-z0-9+/_=-]{20,})/gi,
    valueGroup: 1,
  },
];

/**
 * Scan a text blob for high-confidence secret patterns.
 *
 * The scanner is intentionally conservative: placeholders and local-only test
 * values are allowlisted, while real-looking credentials fail the check.
 *
 * @param {string} text
 * @param {string} [file]
 * @returns {{ file: string, line: number, rule: string }[]}
 */
export function scanText(text, file = "<memory>") {
  const findings = [];

  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const value = rule.valueGroup ? match[rule.valueGroup] : match[0];
      if (isAllowed(value) || isAllowed(match[0])) {
        continue;
      }

      findings.push({
        file,
        line: lineNumberAt(text, match.index ?? 0),
        rule: rule.name,
      });
    }
  }

  return findings;
}

/**
 * Scan every tracked file and reject tracked environment files.
 *
 * @param {{ cwd?: string }} [options]
 * @returns {{ findings: { file: string, line: number, rule: string }[], filesChecked: number }}
 */
export function scanRepository(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);

  const findings = [];
  for (const file of files) {
    if (file === ".env" || (file.startsWith(".env.") && file !== ".env.example")) {
      findings.push({ file, line: 0, rule: "tracked-env-file" });
    }
  }

  let filesChecked = 0;
  for (const file of files) {
    const absolutePath = `${cwd}/${file}`;
    let size;
    try {
      size = statSync(absolutePath).size;
    } catch {
      continue;
    }

    if (size > MAX_FILE_BYTES) {
      continue;
    }

    const contents = readFileSync(absolutePath);
    if (contents.includes(0)) {
      continue;
    }

    filesChecked += 1;
    findings.push(...scanText(contents.toString("utf8"), file));
  }

  return { findings, filesChecked };
}

function isAllowed(value) {
  if (!value) {
    return true;
  }

  return ALLOWLIST.some((pattern) => pattern.test(value));
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function main() {
  const { findings, filesChecked } = scanRepository();

  if (findings.length > 0) {
    console.error(`Secret scan failed: ${findings.length} finding(s).`);
    for (const finding of findings) {
      const location = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
      console.error(`- ${finding.rule}: ${location}`);
    }
    process.exit(1);
  }

  console.log(
    `Secret scan passed: ${filesChecked} tracked text files checked; no high-confidence secret patterns found.`,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
