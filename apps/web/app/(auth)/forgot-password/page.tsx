"use client";

import Link from "next/link";

import { AuthCard } from "@/components/ui/auth-card";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PreviewForm } from "@/components/ui/preview-form";
import { DocumentTitle } from "@/src/i18n/document-title";
import { useI18n } from "@/src/i18n/provider";

export default function ForgotPasswordPage() {
  const { t } = useI18n();

  return (
    <AuthCard
      title={t("auth.forgot.title")}
      description={t("auth.forgot.description")}
      footer={
        <p>
          {t("auth.forgot.footerRemembered")}{" "}
          <Link href="/sign-in">{t("auth.forgot.footerSignIn")}</Link>.{" "}
          {t("auth.forgot.footerToken")}{" "}
          <Link href="/reset-password">{t("auth.forgot.footerReset")}</Link>.
        </p>
      }
    >
      <DocumentTitle titleKey="documentTitle.forgotPassword" />
      <div className="u-stack">
        <PlaceholderNotice title={t("auth.forgot.noticeTitle")}>
          <p>{t("auth.forgot.noticeBody")}</p>
        </PlaceholderNotice>

        <PreviewForm
          fields={[
            {
              name: "email",
              label: t("common.email"),
              type: "email",
              autoComplete: "email",
              required: true,
              placeholder: "you@example.com",
              hint: t("auth.forgot.emailHint"),
            },
          ]}
          submitLabel={t("auth.forgot.submit")}
          statusMessage={t("auth.forgot.status")}
        />
      </div>
    </AuthCard>
  );
}
