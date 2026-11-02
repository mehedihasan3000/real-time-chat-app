"use client";

import { useI18n } from "@/src/i18n/provider";
import styles from "./status.module.css";

export default function RootLoading() {
  const { t } = useI18n();

  return (
    <main id="main-content" className={styles.shell} tabIndex={-1}>
      <section className={styles.card} role="status" aria-live="polite">
        <p className={styles.eyebrow}>{t("status.loadingEyebrow")}</p>
        <h1 className={styles.title}>{t("status.loadingTitle")}</h1>
        <p className={styles.description}>{t("status.loadingDescription")}</p>
      </section>
    </main>
  );
}
