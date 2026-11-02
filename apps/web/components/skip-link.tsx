"use client";

import { useI18n } from "@/src/i18n/provider";

export function SkipLink() {
  const { t } = useI18n();

  return (
    <a className="skip-link" href="#main-content">
      {t("common.skipToContent")}
    </a>
  );
}
