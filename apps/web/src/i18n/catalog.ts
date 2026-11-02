import { defaultLocale, type Locale } from "@chat/contracts";

import bn from "../../messages/bn.json";
import en from "../../messages/en.json";

type CatalogKey = keyof typeof en;

/**
 * Plural messages are stored as `<base>.one` / `<base>.other`. Callers pass
 * the base key plus a numeric `count`, so the base key is a valid message key
 * even though it is not itself a catalog entry.
 */
type PluralBaseKey<K extends string> = K extends `${infer Base}.other` ? Base : never;

export type MessageKey = CatalogKey | PluralBaseKey<CatalogKey>;
export type Catalog = Record<CatalogKey, string>;

const catalogs: Record<Locale, Catalog> = {
  en,
  bn,
};

export function getCatalog(locale: Locale): Catalog {
  return catalogs[locale] ?? catalogs[defaultLocale];
}

export function isMessageKey(value: string): value is MessageKey {
  return Object.prototype.hasOwnProperty.call(en, value);
}
