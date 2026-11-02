"use client";

import { GlobeIcon } from "@/components/icons";
import { supportedLocales, type Locale } from "@chat/contracts";

import { useI18n } from "@/src/i18n/provider";
import styles from "@/components/theme/theme-controls.module.css";

const descriptions: Record<Locale, "locale.englishDescription" | "locale.bengaliDescription"> = {
  en: "locale.englishDescription",
  bn: "locale.bengaliDescription",
};

export function LocaleControl() {
  const { locale, setLocale, t } = useI18n();

  return (
    <div className={styles.control}>
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t("locale.label")}</legend>
        <div
          className={styles.options}
          style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}
        >
          {supportedLocales.map((option) => (
            <label className={styles.option} key={option}>
              <input
                className="visually-hidden"
                type="radio"
                name="interface-language"
                value={option}
                checked={locale === option}
                onChange={() => setLocale(option)}
              />
              <span className={styles.optionBody}>
                <span className={styles.optionIcon} aria-hidden="true">
                  <GlobeIcon size={18} />
                </span>
                <span className={styles.optionCopy}>
                  <span className={styles.optionLabel} lang={option}>
                    {option === "en" ? t("locale.english") : t("locale.bengali")}
                  </span>
                  <span className={styles.optionDescription}>{t(descriptions[option])}</span>
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <p className={styles.status} role="status">
        {t("locale.showingLanguage", {
          language: locale === "en" ? t("locale.english") : t("locale.bengali"),
        })}
      </p>
      <p className={styles.note}>{t("locale.storedNote")}</p>
    </div>
  );
}
