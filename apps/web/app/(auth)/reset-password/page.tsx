"use client";

import Link from "next/link";

import { AuthCard } from "@/components/ui/auth-card";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PreviewForm } from "@/components/ui/preview-form";
import { DocumentTitle } from "@/src/i18n/document-title";
import { useI18n } from "@/src/i18n/provider";

export default function ResetPasswordPage() {
  const { t } = useI18n();

  return (
    <AuthCard
      title={t("auth.reset.title")}
      description={t("auth.reset.description")}
      footer={
        <p>
          {t("auth.reset.footerNeed")}{" "}
          <Link href="/forgot-password">{t("auth.reset.footerForgot")}</Link>.{" "}
          {t("auth.reset.footerSignIn")}.
        </p>
      }
    >
      <DocumentTitle titleKey="documentTitle.resetPassword" />
      <div className="u-stack">
        <PlaceholderNotice title={t("auth.reset.noticeTitle")} tone="warning">
          <p>{t("auth.reset.noticeBody")}</p>
        </PlaceholderNotice>

        <PreviewForm
          fields={[
            {
              name: "new-password",
              label: t("auth.reset.newPassword"),
              type: "password",
              autoComplete: "new-password",
              required: true,
              minLength: 12,
              maxLength: 128,
              hint: t("auth.reset.passwordHint"),
            },
            {
              name: "confirm-password",
              label: t("auth.reset.confirmPassword"),
              type: "password",
              autoComplete: "new-password",
              required: true,
              minLength: 12,
              maxLength: 128,
            },
          ]}
          submitLabel={t("auth.reset.submit")}
          statusMessage={t("auth.reset.status")}
        />
      </div>
    </AuthCard>
  );
}
