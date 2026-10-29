import type { Metadata } from "next";
import Link from "next/link";

import { AuthCard } from "@/components/ui/auth-card";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PreviewAction } from "@/components/ui/preview-action";
import { PreviewForm } from "@/components/ui/preview-form";
import surfaceStyles from "@/components/ui/surface.module.css";

export const metadata: Metadata = {
  title: "Sign in",
};

export default function SignInPage() {
  return (
    <AuthCard
      title="Sign in"
      description="Preview the sign-in screen. No credentials are sent and no session is created."
      footer={
        <p>
          New here? <Link href="/sign-up">Create an account</Link>. You can also{" "}
          <Link href="/verify-email">verify an email</Link> or{" "}
          <Link href="/forgot-password">recover a password</Link>.
        </p>
      }
    >
      <div className="u-stack">
        <PlaceholderNotice title="Authentication is not implemented yet">
          <p>
            This screen exists to lock the layout and labels. Email/password sign-in, Google
            sign-in, sessions, and the 5-minute API token land in P1-06.
          </p>
        </PlaceholderNotice>

        <PreviewForm
          fields={[
            {
              name: "email",
              label: "Email",
              type: "email",
              autoComplete: "email",
              required: true,
              placeholder: "you@example.com",
            },
            {
              name: "password",
              label: "Password",
              type: "password",
              autoComplete: "current-password",
              required: true,
              minLength: 12,
              maxLength: 128,
              hint: "Passwords are 12–128 characters. No password is checked in this preview.",
            },
          ]}
          submitLabel="Preview sign in"
          statusMessage="Preview only: no credentials were sent and no session was created. Sign-in behavior lands in P1-06."
        >
          <label className={surfaceStyles.checkboxRow} htmlFor="remember-browser">
            <input id="remember-browser" name="remember-browser" type="checkbox" />
            <span>Remember this browser for 30 days (preview only)</span>
          </label>
        </PreviewForm>

        <div>
          <PreviewAction
            message="Google sign-in is not implemented. No OAuth request was made; account linking is part of P1-06."
            describedBy="google-sign-in-hint"
          >
            Continue with Google (preview)
          </PreviewAction>
          <p className={surfaceStyles.hint} id="google-sign-in-hint">
            Google sign-in will require explicit account linking and a configured OAuth redirect.
          </p>
        </div>
      </div>
    </AuthCard>
  );
}
