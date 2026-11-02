"use client";

import Link from "next/link";

import { ActionLink } from "@/components/ui/action-link";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { StatePanel } from "@/components/ui/state-panel";
import surface from "@/components/ui/surface.module.css";
import { errorCopyFor } from "@/src/i18n/errors";
import { DocumentTitle } from "@/src/i18n/document-title";
import { useI18n } from "@/src/i18n/provider";

import styles from "./states.module.css";

export default function StatesPage() {
  const { t } = useI18n();

  return (
    <div className="u-stack">
      <DocumentTitle titleKey="documentTitle.states" />
      <PageHeader
        eyebrow={t("states.eyebrow")}
        title={t("states.title")}
        description={t("states.description")}
        actions={
          <ActionLink href="/" variant="secondary">
            {t("common.backToUiSurfaces")}
          </ActionLink>
        }
      />

      <PlaceholderNotice title={t("states.noticeTitle")}>
        <p>{t("states.noticeBody")}</p>
      </PlaceholderNotice>

      <section aria-labelledby="state-gallery-title">
        <h2 className="u-section-title" id="state-gallery-title">
          {t("states.sharedTitle")}
        </h2>
        <div className={styles.gallery} style={{ marginTop: "var(--space-3)" }}>
          <StatePanel
            kind="loading"
            title={t("states.loadingTitle")}
            description={t("states.loadingDescription")}
          />
          <StatePanel
            kind="empty"
            title={t("states.emptyTitle")}
            description={t("states.emptyDescription")}
            action={<Link href="/search">{t("common.searchByUsername")}</Link>}
          />
          <StatePanel
            kind="error"
            title={t("states.errorTitle")}
            description={t("states.errorDescription")}
          />
          <StatePanel
            kind="disconnected"
            title={t("states.disconnectedTitle")}
            description={t("states.disconnectedDescription")}
          />
          <StatePanel
            kind="unauthorized"
            title={t("states.unauthorizedTitle")}
            description={t("states.unauthorizedDescription")}
            action={<Link href="/sign-in">{t("common.openSignIn")}</Link>}
          />
          <StatePanel
            kind="unsupported"
            title={t("states.unsupportedTitle")}
            description={t("states.unsupportedDescription")}
          />
          <StatePanel
            kind="info"
            title={t("states.infoTitle")}
            description={t("states.infoDescription")}
          />
          <StatePanel
            kind="error"
            title={t("states.keyRecoveryTitle")}
            description={t("states.keyRecoveryDescription")}
          />
          <StatePanel
            kind="info"
            title={t("states.permissionTitle")}
            description={t("states.permissionDescription")}
          />
        </div>
      </section>

      <section className={surface.card} aria-labelledby="error-codes-title">
        <h2 className={surface.cardTitle} id="error-codes-title">
          {t("states.errorCodesTitle")}
        </h2>
        <p className={surface.cardDescription}>{t("states.errorCodesDescription")}</p>
        <ul className={styles.errorList}>
          {["RATE_LIMITED", "UNAUTHENTICATED", "INTERNAL_ERROR"].map((code) => {
            const copy = errorCopyFor(code);

            return (
              <li key={code}>
                <code className={styles.errorCode}>{copy.code}</code>
                <div>
                  <p className={styles.errorTitle}>{t(copy.titleKey)}</p>
                  <p className={styles.errorDescription}>{t(copy.descriptionKey)}</p>
                </div>
              </li>
            );
          })}
          <li>
            <code className={styles.errorCode}>{t("states.unknownCode")}</code>
            <div>
              <p className={styles.errorTitle}>{t(errorCopyFor("raw").titleKey)}</p>
              <p className={styles.errorDescription}>
                {t(errorCopyFor("raw").descriptionKey)} {t("states.rawProviderNote")}
              </p>
            </div>
          </li>
        </ul>
      </section>

      <section className={surface.card} aria-labelledby="state-map-title">
        <h2 className={surface.cardTitle} id="state-map-title">
          {t("states.mapTitle")}
        </h2>
        <ul className={styles.mapList}>
          <li>
            <Link href="/conversations">{t("nav.chats")}</Link>: {t("states.mapChats")}
          </li>
          <li>
            <Link href="/conversations/sample-conversation">{t("thread.title")}</Link>:{" "}
            {t("states.mapThread")}
          </li>
          <li>
            <Link href="/search">{t("nav.search")}</Link>: {t("states.mapSearch")}
          </li>
          <li>
            <Link href="/calls">{t("nav.calls")}</Link> and{" "}
            <Link href="/calls/sample-call">{t("nav.call")}</Link>: {t("states.mapCalls")}
          </li>
          <li>
            <Link href="/ai">{t("nav.aiAssist")}</Link>: {t("states.mapAi")}
          </li>
          <li>
            <Link href="/sign-in">{t("auth.eyebrow")}</Link>: {t("states.mapAuth")}
          </li>
        </ul>
      </section>
    </div>
  );
}
