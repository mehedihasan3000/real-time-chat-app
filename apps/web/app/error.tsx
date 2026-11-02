"use client";

import Link from "next/link";

import { ActionButton } from "@/components/ui/action-button";
import { DocumentTitle } from "@/src/i18n/document-title";
import { useI18n } from "@/src/i18n/provider";
import styles from "./status.module.css";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useI18n();

  return (
    <main id="main-content" className={styles.shell} tabIndex={-1}>
      <DocumentTitle titleKey="documentTitle.error" />
      <section className={styles.card} role="alert" aria-labelledby="error-title">
        <p className={styles.eyebrow}>{t("status.errorEyebrow")}</p>
        <h1 className={styles.title} id="error-title">
          {t("status.errorTitle")}
        </h1>
        <p className={styles.description}>{t("status.errorDescription")}</p>
        {error.digest ? (
          <p className={styles.reference}>
            {t("status.safeReference")} <code>{error.digest}</code>
          </p>
        ) : null}
        <div className={styles.actions}>
          <ActionButton variant="primary" onClick={reset}>
            {t("common.tryAgain")}
          </ActionButton>
          <Link href="/">{t("common.returnHome")}</Link>
          <Link href="/states">{t("common.viewUiStates")}</Link>
        </div>
      </section>
    </main>
  );
}
