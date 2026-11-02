"use client";

import { StatePanel } from "@/components/ui/state-panel";
import { useI18n } from "@/src/i18n/provider";

export default function AppLoading() {
  const { t } = useI18n();

  return (
    <StatePanel
      kind="loading"
      title={t("status.appLoadingTitle")}
      description={t("status.appLoadingDescription")}
      live
    />
  );
}
