"use client";

import Link from "next/link";

import { AuthCard } from "@/components/ui/auth-card";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PreviewForm } from "@/components/ui/preview-form";
import { StatePanel } from "@/components/ui/state-panel";
import { DocumentTitle } from "@/src/i18n/document-title";
import { useI18n } from "@/src/i18n/provider";

export default function VerifyEmailPage() {
  const { t } = useI18n();

  return (
    <AuthCard
      title={t("auth.verify.title")}
      description={t("auth.verify.description")}
      footer={
        <p>
          {t("auth.verify.footerOnce")} <Link href="/sign-in">{t("auth.verify.footerSignIn")}</Link>
          . {t("auth.verify.footerNeed")}{" "}
          <Link href="/forgot-password">{t("auth.verify.footerForgot")}</Link>.
        </p>
      }
    >
      <DocumentTitle titleKey="documentTitle.verifyEmail" />
      <div className="u-stack">
        <PlaceholderNotice title={t("auth.verify.noticeTitle")}>
          <p>{t("auth.verify.noticeBody")}</p>
        </PlaceholderNotice>

        <StatePanel
          kind="info"
          title={t("auth.verify.pendingTitle")}
          description={t("auth.verify.pendingDescription")}
        />

        <PreviewForm
          fields={[
            {
              name: "email",
              label: t("common.email"),
              type: "email",
              autoComplete: "email",
              required: true,
              placeholder: "you@example.com",
              hint: t("auth.verify.emailHint"),
            },
          ]}
          submitLabel={t("auth.verify.submit")}
          statusMessage={t("auth.verify.status")}
        />
      </div>
    </AuthCard>
  );
}
