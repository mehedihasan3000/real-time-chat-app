"use client";

import Link from "next/link";

import { AuthCard } from "@/components/ui/auth-card";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PreviewAction } from "@/components/ui/preview-action";
import { PreviewForm } from "@/components/ui/preview-form";
import surfaceStyles from "@/components/ui/surface.module.css";
import { DocumentTitle } from "@/src/i18n/document-title";
import { useI18n } from "@/src/i18n/provider";

export default function SignUpPage() {
  const { t } = useI18n();

  return (
    <AuthCard
      title={t("auth.signUp.title")}
      description={t("auth.signUp.description")}
      footer={
        <>
          <p>
            {t("auth.signUp.footerAlready")}{" "}
            <Link href="/sign-in">{t("auth.signUp.footerSignIn")}</Link>.{" "}
            {t("auth.signUp.footerVerifyPrefix")}{" "}
            <Link href="/verify-email">{t("auth.signUp.footerVerify")}</Link>.
          </p>
          <p>
            {t("auth.signUp.footerNext")}{" "}
            <Link href="/onboarding/profile">{t("auth.signUp.footerProfileSetup")}</Link>.
          </p>
        </>
      }
    >
      <DocumentTitle titleKey="documentTitle.signUp" />
      <div className="u-stack">
        <PlaceholderNotice title={t("auth.signUp.noticeTitle")}>
          <p>{t("auth.signUp.noticeBody")}</p>
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
              hint: t("auth.signUp.emailHint"),
            },
            {
              name: "password",
              label: t("common.password"),
              type: "password",
              autoComplete: "new-password",
              required: true,
              minLength: 12,
              maxLength: 128,
              hint: t("auth.signUp.passwordHint"),
            },
          ]}
          submitLabel={t("auth.signUp.submit")}
          statusMessage={t("auth.signUp.status")}
        />

        <div>
          <PreviewAction message={t("auth.signUp.googleMessage")} describedBy="google-sign-up-hint">
            {t("auth.signUp.google")}
          </PreviewAction>
          <p className={surfaceStyles.hint} id="google-sign-up-hint">
            {t("auth.signUp.googleHint")}
          </p>
        </div>
      </div>
    </AuthCard>
  );
}
