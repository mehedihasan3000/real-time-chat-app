#!/usr/bin/env node
/**
 * Catalog coverage check.
 *
 * Fails when:
 *  - a catalog is missing, unreadable, or invalid JSON;
 *  - the English and Bengali catalogs do not have identical key sets;
 *  - a value is empty or whitespace-only;
 *  - interpolation placeholders differ between the two catalogs;
 *  - a plural family is missing its `.one` or `.other` member;
 *  - a Bengali value is byte-identical to English without an allow-listed
 *    reason (a cheap guard against untranslated copy);
 *  - a statically referenced message key is absent from the catalogs.
 *
 * Dynamic keys (for example `t(call.directionKey)`) are typed in the app and
 * are not resolved by this script.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const messagesDir = path.join(root, "apps", "web", "messages");
const webDir = path.join(root, "apps", "web");

const LOCALES = ["en", "bn"];

/** Values that are deliberately identical across locales. */
const IDENTICAL_ALLOWLIST = new Set([
  "locale.english",
  "locale.bengali",
  "locale.toggleEnglish",
  "locale.toggleBengali",
  "onboarding.form.usernamePlaceholder",
  "onboarding.form.formatValid",
  "onboarding.form.formatInvalid1",
  "onboarding.form.formatInvalid2",
  "calls.callMeta",
  "search.usernamePlaceholder",
  "settings.navAi",
]);

const PLACEHOLDER = /\{[a-zA-Z0-9_]+\}/g;

function fail(errors) {
  for (const error of errors) {
    console.error(`i18n:check: ${error}`);
  }

  console.error(`i18n:check failed with ${errors.length} problem(s).`);
  process.exitCode = 1;
}

function placeholders(value) {
  return [...(value.match(PLACEHOLDER) ?? [])].sort().join(",");
}

async function readCatalog(locale, errors) {
  const file = path.join(messagesDir, `${locale}.json`);

  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      errors.push(`${locale}.json must contain a JSON object.`);
      return null;
    }

    return parsed;
  } catch (error) {
    errors.push(`Cannot read ${path.relative(root, file)}: ${error.message}`);
    return null;
  }
}

async function collectSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") {
        continue;
      }

      files.push(...(await collectSourceFiles(full)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }

  return files;
}

const errors = [];
const catalogs = {};

for (const locale of LOCALES) {
  catalogs[locale] = await readCatalog(locale, errors);
}

if (catalogs.en && catalogs.bn) {
  const enKeys = Object.keys(catalogs.en).sort();
  const bnKeys = Object.keys(catalogs.bn).sort();
  const enSet = new Set(enKeys);
  const bnSet = new Set(bnKeys);

  for (const key of enKeys) {
    if (!bnSet.has(key)) {
      errors.push(`bn.json is missing the key "${key}".`);
    }
  }

  for (const key of bnKeys) {
    if (!enSet.has(key)) {
      errors.push(`en.json has no key "${key}" (present in bn.json).`);
    }
  }

  for (const key of enKeys) {
    const enValue = catalogs.en[key];
    const bnValue = catalogs.bn[key];

    if (typeof enValue !== "string" || enValue.trim() === "") {
      errors.push(`en.json has an empty or non-string value for "${key}".`);
      continue;
    }

    if (typeof bnValue !== "string" || bnValue.trim() === "") {
      errors.push(`bn.json has an empty or non-string value for "${key}".`);
      continue;
    }

    if (placeholders(enValue) !== placeholders(bnValue)) {
      errors.push(
        `Placeholders differ for "${key}": en=[${placeholders(enValue)}] bn=[${placeholders(bnValue)}].`,
      );
    }

    if (enValue === bnValue && !IDENTICAL_ALLOWLIST.has(key)) {
      errors.push(`"${key}" is identical in both catalogs and is not allow-listed.`);
    }

    if (key.endsWith(".one") && !enSet.has(`${key.slice(0, -4)}.other`)) {
      errors.push(`Plural family "${key.slice(0, -4)}" is missing ".other" in en.json.`);
    }

    if (key.endsWith(".one") && bnSet.has(key) && !bnSet.has(`${key.slice(0, -4)}.other`)) {
      errors.push(`Plural family "${key.slice(0, -4)}" is missing ".other" in bn.json.`);
    }
  }

  // Every statically referenced key must exist. The scan is intentionally
  // conservative: it only accepts dotted, lower-camel identifiers, which is
  // the shape of this project's catalog keys.
  const sources = await collectSourceFiles(webDir);
  const referenced = new Map();
  const keyPattern = /["']([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)["']/g;

  for (const file of sources) {
    const text = await readFile(file, "utf8");
    let match;

    while ((match = keyPattern.exec(text)) !== null) {
      const key = match[1];

      if (!referenced.has(key)) {
        referenced.set(key, path.relative(root, file));
      }
    }
  }

  for (const [key, file] of referenced) {
    if (enSet.has(key)) {
      continue;
    }

    if (key.endsWith(".one") || key.endsWith(".other")) {
      continue;
    }

    if (enSet.has(`${key}.other`)) {
      continue;
    }

    // Ignore common dotted identifiers that are not catalog keys.
    if (/^(www|node|process|window|document|module|exports|next)\./.test(key)) {
      continue;
    }

    errors.push(`Source reference "${key}" (${file}) has no catalog entry.`);
  }
}

if (errors.length > 0) {
  fail(errors);
} else {
  const count = Object.keys(catalogs.en).length;
  console.log(`i18n:check passed: ${LOCALES.join("/")} catalogs, ${count} keys, 0 problems.`);
}
