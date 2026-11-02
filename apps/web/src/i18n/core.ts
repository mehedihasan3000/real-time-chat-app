import { defaultLocale, type Locale } from "@chat/contracts";

import { getCatalog, type MessageKey } from "./catalog";

export type MessageParams = Record<string, string | number>;

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

const bcp47: Record<Locale, string> = {
  en: "en-GB",
  bn: "bn-BD",
};

export function toBcp47(locale: Locale): string {
  return bcp47[locale] ?? bcp47[defaultLocale];
}

export function formatNumber(value: number, locale: Locale): string {
  try {
    return new Intl.NumberFormat(toBcp47(locale)).format(value);
  } catch {
    return String(value);
  }
}

/**
 * Resolves a catalog message with pluralization and interpolation.
 *
 * A caller passes the base key plus a numeric `count`; the function selects
 * the CLDR plural category for the active locale and falls back to `.other`
 * before the base key. Every `{placeholder}` is replaced from `params`.
 */
export function resolveMessage(locale: Locale, key: string, params?: MessageParams): string {
  const catalog = getCatalog(locale);
  const fallback = getCatalog(defaultLocale);
  const record = catalog as Record<string, string | undefined>;
  const fallbackRecord = fallback as Record<string, string | undefined>;

  let template = record[key];

  if (template === undefined && params && typeof params.count === "number") {
    const category = new Intl.PluralRules(toBcp47(locale)).select(params.count);
    template = record[`${key}.${category}`] ?? record[`${key}.other`];
  }

  template = template ?? fallbackRecord[key];

  if (template === undefined) {
    return key;
  }

  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = params?.[name];

    if (value === undefined) {
      return match;
    }

    return typeof value === "number" ? formatNumber(value, locale) : value;
  });
}

export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  return resolveMessage(locale, key, params);
}

/**
 * The display timezone is the browser timezone with a UTC fallback. It is
 * display-only: no timezone preference is stored in this build.
 */
export function getDisplayTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone || "UTC";
  } catch {
    return "UTC";
  }
}

export function formatDateTime(
  value: string | number | Date,
  locale: Locale,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
): string {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  try {
    return new Intl.DateTimeFormat(toBcp47(locale), { timeZone, ...options }).format(date);
  } catch {
    try {
      return new Intl.DateTimeFormat(toBcp47(locale), { ...options, timeZone: "UTC" }).format(date);
    } catch {
      return "";
    }
  }
}

export function formatDuration(totalSeconds: number, locale: Locale): string {
  const safeSeconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;

  if (minutes === 0) {
    return resolveMessage(locale, "time.duration.seconds", { count: seconds });
  }

  if (seconds === 0) {
    return resolveMessage(locale, "time.duration.minutes", { count: minutes });
  }

  return `${resolveMessage(locale, "time.duration.minutes", { count: minutes })} ${resolveMessage(
    locale,
    "time.duration.seconds",
    { count: seconds },
  )}`;
}
