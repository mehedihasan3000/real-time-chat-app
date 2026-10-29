import type { Metadata } from "next";
import Link from "next/link";

import { AuthCard } from "@/components/ui/auth-card";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PreviewAction } from "@/components/ui/preview-action";
import { PreviewForm } from "@/components/ui/preview-form";
import surfaceStyles from "@/components/ui/surface.module.css";

export const metadata: Metadata = {
  title: "Create account",
};

export default function SignUpPage() {
  return (
    <AuthCard
      title="Create an account"
      description="Preview the registration screen. No account is created and no email is sent."
      footer={
        <p>
          Already registered? <Link href="/sign-in">Sign in</Link>. Email verification is previewed
          at <Link href="/verify-email">verify email</Link>.
        </p>
      }
    >
      <div className="u-stack">
        <PlaceholderNotice title="Registration is not implemented yet">
          <p>
            Account creation, the common/breached-password deny list, verification resend limits,
            and anti-enumeration behavior land in P1-06. This form does not call an API.
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
              hint: "A verification email will be required before sign-in in the implemented flow.",
            },
            {
              name: "password",
              label: "Password",
              type: "password",
              autoComplete: "new-password",
              required: true,
              minLength: 12,
              maxLength: 128,
              hint: "Use 12–128 characters. The local deny list and breach checks are not implemented in this preview.",
            },
          ]}
          submitLabel="Preview account creation"
          statusMessage="Preview only: no account was created, no email was sent, and no password was stored."
        />

        <div>
          <PreviewAction
            message="Google registration is not implemented. No OAuth request was made; account linking is part of P1-06."
            describedBy="google-sign-up-hint"
          >
            Continue with Google (preview)
          </PreviewAction>
          <p className={surfaceStyles.hint} id="google-sign-up-hint">
            Google registration will require explicit account linking and a configured OAuth
            redirect.
          </p>
        </div>
      </div>
    </AuthCard>
  );
}
