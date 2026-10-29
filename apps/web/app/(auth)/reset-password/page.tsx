import type { Metadata } from "next";
import Link from "next/link";

import { AuthCard } from "@/components/ui/auth-card";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PreviewForm } from "@/components/ui/preview-form";

export const metadata: Metadata = {
  title: "Reset password",
};

export default function ResetPasswordPage() {
  return (
    <AuthCard
      title="Reset password"
      description="Preview the reset-token screen. No token is read, and no password is changed."
      footer={
        <p>
          Need a new link? <Link href="/forgot-password">Request password recovery</Link>. Or{" "}
          <Link href="/sign-in">return to sign in</Link>.
        </p>
      }
    >
      <div className="u-stack">
        <PlaceholderNotice title="Password reset is not implemented yet" tone="warning">
          <p>
            Token validation, single-use enforcement, expiry, session revocation, and the password
            deny list land in P1-06. Do not enter a real password here; this preview has no server.
          </p>
        </PlaceholderNotice>

        <PreviewForm
          fields={[
            {
              name: "new-password",
              label: "New password",
              type: "password",
              autoComplete: "new-password",
              required: true,
              minLength: 12,
              maxLength: 128,
              hint: "12–128 characters. No password is stored or checked in this preview.",
            },
            {
              name: "confirm-password",
              label: "Confirm new password",
              type: "password",
              autoComplete: "new-password",
              required: true,
              minLength: 12,
              maxLength: 128,
            },
          ]}
          submitLabel="Preview password reset"
          statusMessage="Preview only: no token was read and no password was changed."
        />
      </div>
    </AuthCard>
  );
}
