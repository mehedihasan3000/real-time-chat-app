"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "@/components/icons";
import { useI18n } from "@/src/i18n/provider";
import { useTheme, type ThemePreference } from "./theme-provider";

import styles from "./theme-controls.module.css";

const options: ReadonlyArray<{
  value: ThemePreference;
  labelKey: "theme.light" | "theme.dark" | "theme.system";
  descriptionKey: "theme.lightDescription" | "theme.darkDescription" | "theme.systemDescription";
}> = [
  { value: "light", labelKey: "theme.light", descriptionKey: "theme.lightDescription" },
  { value: "dark", labelKey: "theme.dark", descriptionKey: "theme.darkDescription" },
  { value: "system", labelKey: "theme.system", descriptionKey: "theme.systemDescription" },
];

export function ThemeControl() {
  const { preference, resolvedTheme, setPreference } = useTheme();
  const { t } = useI18n();
  const resolvedLabel = resolvedTheme === "dark" ? t("theme.dark") : t("theme.light");

  return (
    <div className={styles.control}>
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t("theme.legend")}</legend>
        <div className={styles.options}>
          {options.map((option) => (
            <label className={styles.option} key={option.value}>
              <input
                className="visually-hidden"
                type="radio"
                name="theme-preference"
                value={option.value}
                checked={preference === option.value}
                onChange={() => setPreference(option.value)}
              />
              <span className={styles.optionBody}>
                <span className={styles.optionIcon} aria-hidden="true">
                  {option.value === "dark" ? (
                    <MoonIcon size={18} />
                  ) : option.value === "light" ? (
                    <SunIcon size={18} />
                  ) : (
                    <MonitorIcon size={18} />
                  )}
                </span>
                <span className={styles.optionCopy}>
                  <span className={styles.optionLabel}>{t(option.labelKey)}</span>
                  <span className={styles.optionDescription}>{t(option.descriptionKey)}</span>
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <p className={styles.status} role="status">
        {t("theme.showingTheme", { theme: resolvedLabel })}
        {preference === "system" ? t("theme.followingDevice") : t("theme.sentenceEnd")}
      </p>
      <p className={styles.note}>{t("theme.storedNote")}</p>
    </div>
  );
}
