"use client";

import Link from "next/link";

import { ActionLink } from "@/components/ui/action-link";
import { DocumentTitle } from "@/src/i18n/document-title";
import { useI18n } from "@/src/i18n/provider";
import styles from "./status.module.css";

export default function NotFound() {
  const { t } = useI18n();

  return (
    <main id="main-content" className={styles.shell} tabIndex={-1}>
      <DocumentTitle titleKey="documentTitle.notFound" />
      <section className={styles.card} aria-labelledby="not-found-title">
        <p className={styles.eyebrow}>{t("status.notFoundEyebrow")}</p>
        <h1 className={styles.title} id="not-found-title">
          {t("status.notFoundTitle")}
        </h1>
        <p className={styles.description}>{t("status.notFoundDescription")}</p>
        <div className={styles.actions}>
          <ActionLink href="/">{t("common.returnHome")}</ActionLink>
          <ActionLink href="/conversations" variant="secondary">
            {t("status.openConversations")}
          </ActionLink>
        </div>
        <p className={styles.reference}>
          {t("status.lookingForStates")} <Link href="/states">{t("status.openUiStates")}</Link>.
        </p>
      </section>
    </main>
  );
}
