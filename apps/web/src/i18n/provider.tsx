"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { defaultLocale, isLocale, type Locale } from "@chat/contracts";

import type { MessageKey } from "./catalog";
import {
  formatDateTime as formatDateTimeFor,
  formatDuration as formatDurationFor,
  getDisplayTimeZone,
  translate,
  type MessageParams,
} from "./core";

const STORAGE_KEY = "chat-ui-locale";
const LOCALE_EVENT = "chat-ui-locale-change";

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  t: (key: MessageKey, params?: MessageParams) => string;
  timeZone: string;
  formatDateTime: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => string;
  formatDuration: (totalSeconds: number) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

// A same-tab fallback for browsers where localStorage is blocked. The switch
// still works for the visit; only the remembered preference is unavailable.
let memoryLocale: Locale | null = null;

function readLocale(): Locale {
  if (memoryLocale) {
    return memoryLocale;
  }

  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isLocale(value) ? value : defaultLocale;
  } catch {
    return defaultLocale;
  }
}

function subscribeLocale(onStoreChange: () => void): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) {
      return;
    }

    memoryLocale = null;
    onStoreChange();
  };

  const handleLocalChange = () => onStoreChange();

  window.addEventListener("storage", handleStorage);
  window.addEventListener(LOCALE_EVENT, handleLocalChange);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(LOCALE_EVENT, handleLocalChange);
  };
}

function getServerLocale(): Locale {
  return defaultLocale;
}

const subscribeToNothing = () => () => {};

function getServerTimeZone(): string {
  return "UTC";
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const locale = useSyncExternalStore(subscribeLocale, readLocale, getServerLocale);
  const timeZone = useSyncExternalStore(subscribeToNothing, getDisplayTimeZone, getServerTimeZone);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    memoryLocale = next;

    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable in private/restricted contexts. The
      // interface still switches for this visit.
    }

    document.documentElement.lang = next;
    window.dispatchEvent(new Event(LOCALE_EVENT));
  }, []);

  const toggleLocale = useCallback(() => {
    setLocale(locale === "en" ? "bn" : "en");
  }, [locale, setLocale]);

  const t = useCallback(
    (key: MessageKey, params?: MessageParams) => translate(locale, key, params),
    [locale],
  );

  const formatDateTime = useCallback(
    (value: string | number | Date, options?: Intl.DateTimeFormatOptions) =>
      formatDateTimeFor(value, locale, timeZone, options),
    [locale, timeZone],
  );

  const formatDuration = useCallback(
    (totalSeconds: number) => formatDurationFor(totalSeconds, locale),
    [locale],
  );

  const value = useMemo(
    () => ({ locale, setLocale, toggleLocale, t, timeZone, formatDateTime, formatDuration }),
    [locale, setLocale, toggleLocale, t, timeZone, formatDateTime, formatDuration],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);

  if (!context) {
    throw new Error("useI18n must be used inside LocaleProvider.");
  }

  return context;
}
