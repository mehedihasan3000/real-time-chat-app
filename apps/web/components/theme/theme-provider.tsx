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

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "chat-ui-theme";
const THEME_EVENT = "chat-ui-theme-change";

type ThemeContextValue = {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

// A same-tab fallback for browsers where localStorage is blocked. It keeps the
// theme switch usable for the visit without pretending the choice is saved.
let memoryPreference: ThemePreference | null = null;

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

function readPreference(): ThemePreference {
  if (memoryPreference) {
    return memoryPreference;
  }

  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isThemePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

function subscribePreference(onStoreChange: () => void): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) {
      return;
    }

    // Another tab is authoritative; drop the same-tab fallback.
    memoryPreference = null;
    onStoreChange();
  };

  const handleLocalChange = () => onStoreChange();

  window.addEventListener("storage", handleStorage);
  window.addEventListener(THEME_EVENT, handleLocalChange);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(THEME_EVENT, handleLocalChange);
  };
}

function getServerPreference(): ThemePreference {
  return "system";
}

function readSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function subscribeSystemTheme(onStoreChange: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onStoreChange);

  return () => media.removeEventListener("change", onStoreChange);
}

function getServerSystemTheme(): ResolvedTheme {
  return "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const preference = useSyncExternalStore(subscribePreference, readPreference, getServerPreference);
  const systemTheme = useSyncExternalStore(
    subscribeSystemTheme,
    readSystemTheme,
    getServerSystemTheme,
  );

  const resolvedTheme: ResolvedTheme = preference === "system" ? systemTheme : preference;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.style.colorScheme = resolvedTheme;

    const color = resolvedTheme === "dark" ? "#1b1218" : "#fbf7f3";
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
      meta.content = color;
    });
  }, [resolvedTheme]);

  const setPreference = useCallback((next: ThemePreference) => {
    memoryPreference = next;

    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable in private/restricted contexts. The theme
      // still works for this visit; only the preference cannot be remembered.
    }

    window.dispatchEvent(new Event(THEME_EVENT));
  }, []);

  const toggleTheme = useCallback(() => {
    setPreference(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setPreference]);

  const value = useMemo(
    () => ({ preference, resolvedTheme, setPreference, toggleTheme }),
    [preference, resolvedTheme, setPreference, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);

  if (!context) {
    throw new Error("useTheme must be used inside ThemeProvider.");
  }

  return context;
}
