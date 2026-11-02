"use client";

import { GlobeIcon } from "@/components/icons";
import { useI18n } from "@/src/i18n/provider";
import controlStyles from "@/components/theme/theme-controls.module.css";

export function LocaleToggle({ className }: { className?: string }) {
  const { locale, toggleLocale, t } = useI18n();
  const next = locale === "en" ? "bn" : "en";
  const label = next === "en" ? t("locale.toggleEnglish") : t("locale.toggleBengali");
  const ariaLabel = next === "en" ? t("locale.switchToEnglish") : t("locale.switchToBengali");

  return (
    <button
      type="button"
      className={`${controlStyles.toggle} ${className ?? ""}`}
      onClick={toggleLocale}
      aria-label={ariaLabel}
      title={ariaLabel}
      lang={next}
    >
      <span className={controlStyles.toggleIcon} aria-hidden="true">
        <GlobeIcon size={20} />
      </span>
      <span className={controlStyles.toggleText}>{label}</span>
    </button>
  );
}
