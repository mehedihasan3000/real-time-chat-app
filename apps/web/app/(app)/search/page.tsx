"use client";

import Link from "next/link";

import { SearchIcon } from "@/components/icons";
import { ActionLink } from "@/components/ui/action-link";
import { GeneratedAvatar } from "@/components/ui/avatar";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PreviewForm } from "@/components/ui/preview-form";
import { StatePanel } from "@/components/ui/state-panel";
import surface from "@/components/ui/surface.module.css";
import { sampleProfile } from "@/lib/preview-data";
import { DocumentTitle } from "@/src/i18n/document-title";
import { useI18n } from "@/src/i18n/provider";

import styles from "./search.module.css";

export default function SearchPage() {
  const { t } = useI18n();

  return (
    <div className="u-stack">
      <DocumentTitle titleKey="documentTitle.search" />
      <PageHeader
        eyebrow={t("search.eyebrow")}
        title={t("search.title")}
        description={t("search.description")}
        actions={
          <ActionLink href="/conversations" variant="secondary">
            {t("common.backToChats")}
          </ActionLink>
        }
      />

      <PlaceholderNotice title={t("search.noticeTitle")}>
        <p>{t("search.noticeBody")}</p>
      </PlaceholderNotice>

      <section className={styles.searchCard} aria-labelledby="search-form-title">
        <span className={styles.searchIcon} aria-hidden="true">
          <SearchIcon size={26} />
        </span>
        <h2 className={styles.searchTitle} id="search-form-title">
          {t("search.formTitle")}
        </h2>
        <p className={styles.searchBody}>{t("search.formBody")}</p>
        <div className={styles.formWrap}>
          <PreviewForm
            fields={[
              {
                name: "username",
                label: t("search.usernameLabel"),
                type: "search",
                autoComplete: "off",
                required: true,
                minLength: 3,
                maxLength: 24,
                placeholder: t("search.usernamePlaceholder"),
                hint: t("search.usernameHint"),
              },
            ]}
            submitLabel={t("search.submit")}
            statusMessage={t("search.status")}
          />
        </div>
        <p className={styles.searchNote}>{t("search.note")}</p>
      </section>

      <section className={surface.card} aria-labelledby="sample-result-title">
        <div className={surface.cardHeader}>
          <div>
            <h2 className={surface.cardTitle} id="sample-result-title">
              {t("search.sampleTitle")}
            </h2>
            <p className={surface.cardDescription}>{t("search.sampleDescription")}</p>
          </div>
          <span className={surface.badge}>{t("common.sample")}</span>
        </div>
        <Link className={styles.resultRow} href={`/profile/${sampleProfile.username}`}>
          <GeneratedAvatar userId={sampleProfile.userId} name={sampleProfile.name} size="md" />
          <span className={styles.resultCopy}>
            <span className={styles.resultName}>{sampleProfile.name}</span>
            <span className={styles.resultHandle}>@{sampleProfile.username}</span>
          </span>
          <span className={styles.resultAction}>{t("search.viewSampleProfile")}</span>
        </Link>
      </section>

      <section aria-labelledby="search-states-title">
        <h2 className="u-section-title" id="search-states-title">
          {t("search.statesTitle")}
        </h2>
        <div className="u-grid" style={{ marginTop: "var(--space-3)" }}>
          <StatePanel
            kind="empty"
            title={t("search.stateNoMatchTitle")}
            description={t("search.stateNoMatchDescription")}
          />
          <StatePanel
            kind="unsupported"
            title={t("search.stateUnsupportedTitle")}
            description={t("search.stateUnsupportedDescription")}
          />
          <StatePanel
            kind="unauthorized"
            title={t("search.stateSignInTitle")}
            description={t("search.stateSignInDescription")}
            action={<Link href="/sign-in">{t("common.openSignIn")}</Link>}
          />
        </div>
      </section>
    </div>
  );
}
