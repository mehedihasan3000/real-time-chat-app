import type { Metadata } from "next";
import Link from "next/link";

import { AuthCard } from "@/components/ui/auth-card";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PreviewForm } from "@/components/ui/preview-form";
import { StatePanel } from "@/components/ui/state-panel";

export const metadata: Metadata = {
  title: "Verify email",
};

export default function VerifyEmailPage() {
  return (
    <AuthCard
      title="Verify your email"
      description="Preview the verification and resend states. No verification token is issued or checked."
      footer={
        <p>
          Once verified, you would <Link href="/sign-in">sign in</Link>. Need a new link?{" "}
          <Link href="/forgot-password">Recover access</Link>.
        </p>
      }
    >
      <div className="u-stack">
        <PlaceholderNotice title="Email delivery is not implemented yet">
          <p>
            Verification tokens, Resend delivery, resend limits, and the unverified-account cleanup
            land in P1-06. Nothing on this page contacts an email provider.
          </p>
        </PlaceholderNotice>

        <StatePanel
          kind="info"
          title="Verification pending"
          description="The implemented flow will show this state until the emailed link is opened. This static preview cannot become verified."
        />

        <PreviewForm
          fields={[
            {
              name: "email",
              label: "Email",
              type: "email",
              autoComplete: "email",
              required: true,
              placeholder: "you@example.com",
              hint: "The implemented response is generic so it does not disclose whether an account exists.",
            },
          ]}
          submitLabel="Preview resend"
          statusMessage="Preview only: no email was sent and no resend limit was applied."
        />
      </div>
    </AuthCard>
  );
}
