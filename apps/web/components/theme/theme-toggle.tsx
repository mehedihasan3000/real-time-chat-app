"use client";

import { MoonIcon, SunIcon } from "@/components/icons";
import { useI18n } from "@/src/i18n/provider";
import { useTheme } from "./theme-provider";

import styles from "./theme-controls.module.css";

export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, toggleTheme } = useTheme();
  const { t } = useI18n();
  const nextTheme = resolvedTheme === "dark" ? "light" : "dark";
  const nextLabel = nextTheme === "dark" ? t("theme.dark") : t("theme.light");
  const label = resolvedTheme === "dark" ? t("theme.toggleLight") : t("theme.toggleDark");

  return (
    <button
      type="button"
      className={`${styles.toggle} ${className ?? ""}`}
      onClick={toggleTheme}
      aria-label={t("theme.switchTo", { theme: nextLabel })}
      title={t("theme.switchTo", { theme: nextLabel })}
    >
      <span className={styles.toggleIcon} aria-hidden="true">
        {resolvedTheme === "dark" ? <SunIcon size={20} /> : <MoonIcon size={20} />}
      </span>
      <span className={styles.toggleText}>{label}</span>
    </button>
  );
}
