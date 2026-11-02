"use client";

import Link from "next/link";

import { AuthCard } from "@/components/ui/auth-card";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PreviewAction } from "@/components/ui/preview-action";
import { PreviewForm } from "@/components/ui/preview-form";
import surfaceStyles from "@/components/ui/surface.module.css";
import { DocumentTitle } from "@/src/i18n/document-title";
import { useI18n } from "@/src/i18n/provider";

export default function SignInPage() {
  const { t } = useI18n();

  return (
    <AuthCard
      title={t("auth.signIn.title")}
      description={t("auth.signIn.description")}
      footer={
        <p>
          {t("auth.signIn.footer")} <Link href="/sign-up">{t("auth.signIn.footerSignUp")}</Link>.{" "}
          <Link href="/verify-email">{t("auth.signIn.footerVerify")}</Link>{" "}
          <Link href="/forgot-password">{t("auth.signIn.footerForgot")}</Link>.
        </p>
      }
    >
      <DocumentTitle titleKey="documentTitle.signIn" />
      <div className="u-stack">
        <PlaceholderNotice title={t("auth.signIn.noticeTitle")}>
          <p>{t("auth.signIn.noticeBody")}</p>
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
            },
            {
              name: "password",
              label: t("common.password"),
              type: "password",
              autoComplete: "current-password",
              required: true,
              minLength: 12,
              maxLength: 128,
              hint: t("auth.signIn.passwordHint"),
            },
          ]}
          submitLabel={t("auth.signIn.submit")}
          statusMessage={t("auth.signIn.status")}
        >
          <label className={surfaceStyles.checkboxRow} htmlFor="remember-browser">
            <input id="remember-browser" name="remember-browser" type="checkbox" />
            <span>{t("auth.signIn.remember")}</span>
          </label>
        </PreviewForm>

        <div>
          <PreviewAction message={t("auth.signIn.googleMessage")} describedBy="google-sign-in-hint">
            {t("auth.signIn.google")}
          </PreviewAction>
          <p className={surfaceStyles.hint} id="google-sign-in-hint">
            {t("auth.signIn.googleHint")}
          </p>
        </div>
      </div>
    </AuthCard>
  );
}
