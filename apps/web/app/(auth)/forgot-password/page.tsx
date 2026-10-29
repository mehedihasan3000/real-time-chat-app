import type { Metadata } from "next";
import Link from "next/link";

import { AuthCard } from "@/components/ui/auth-card";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PreviewForm } from "@/components/ui/preview-form";

export const metadata: Metadata = {
  title: "Forgot password",
};

export default function ForgotPasswordPage() {
  return (
    <AuthCard
      title="Forgot password"
      description="Preview the recovery request screen. No recovery email is sent."
      footer={
        <p>
          Remembered it? <Link href="/sign-in">Return to sign in</Link>. Already have a token?{" "}
          <Link href="/reset-password">Open the reset screen</Link>.
        </p>
      }
    >
      <div className="u-stack">
        <PlaceholderNotice title="Password recovery is not implemented yet">
          <p>
            Email-only reset, token expiry, session revocation, and the generic anti-enumeration
            response land in P1-06. This form does not call an API.
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
              hint: "The implemented flow returns the same response whether or not the email exists.",
            },
          ]}
          submitLabel="Preview recovery email"
          statusMessage="Preview only: no email was sent. The implemented flow would return a generic response."
        />
      </div>
    </AuthCard>
  );
}
