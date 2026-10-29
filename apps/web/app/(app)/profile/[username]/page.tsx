import type { Metadata } from "next";
import Link from "next/link";

import { ActionLink } from "@/components/ui/action-link";
import { GeneratedAvatar } from "@/components/ui/avatar";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PreviewAction } from "@/components/ui/preview-action";
import { StatePanel } from "@/components/ui/state-panel";
import surface from "@/components/ui/surface.module.css";
import { sampleConversation, sampleProfile } from "@/lib/preview-data";

export const metadata: Metadata = {
  title: "Public profile",
};

export default async function PublicProfilePage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;

  if (username !== sampleProfile.username) {
    return (
      <div className="u-stack">
        <PageHeader
          eyebrow="Profile"
          title="Profile preview"
          description="This route accepts a username, but the shell has no profile data source."
          actions={
            <ActionLink href="/search" variant="secondary">
              Back to search
            </ActionLink>
          }
        />
        <StatePanel
          kind="empty"
          title="No profile data"
          description={`No profile for “${username}” exists in this static preview. Only the labelled sample profile is available.`}
          action={
            <ActionLink href={`/profile/${sampleProfile.username}`} variant="secondary">
              Open the sample profile
            </ActionLink>
          }
        />
      </div>
    );
  }

  return (
    <div className="u-stack">
      <PageHeader
        eyebrow="Public profile"
        title={sampleProfile.name}
        description={`@${sampleProfile.username} · Synthetic sample profile`}
        actions={
          <ActionLink href={`/conversations/${sampleConversation.id}`} variant="secondary">
            Preview conversation
          </ActionLink>
        }
      />

      <PlaceholderNotice title="Profile and safety actions are placeholders">
        <p>
          Blocking and reporting land in P1-18. Profile loading, editing, and discovery land in
          P1-17. The actions below only display a preview notice.
        </p>
      </PlaceholderNotice>

      <section className={surface.card} aria-labelledby="public-profile-title">
        <h2 className="visually-hidden" id="public-profile-title">
          Sample public profile
        </h2>
        <div className={surface.profileCard}>
          <GeneratedAvatar
            userId={sampleProfile.userId}
            name={sampleProfile.name}
            size="lg"
            decorative={false}
          />
          <div>
            <p className={surface.profileName}>{sampleProfile.name}</p>
            <p className={surface.profileHandle}>@{sampleProfile.username}</p>
            <div className={surface.badgeRow} style={{ marginTop: "var(--space-2)" }}>
              <span className={surface.badge}>Sample data</span>
              <span className={surface.badge}>Generated avatar</span>
            </div>
            <p className={surface.cardDescription} style={{ marginTop: "var(--space-3)" }}>
              {sampleProfile.bio}
            </p>
          </div>
        </div>

        <hr className={surface.divider} />

        <div className={surface.actions}>
          <PreviewAction
            message="Blocking is not implemented. No block was recorded and no request was sent; the blocking flow lands in P1-18."
            variant="danger"
            describedBy="block-action-hint"
          >
            Block user (preview)
          </PreviewAction>
          <PreviewAction
            message="Reporting is not implemented. No report was created and no content was selected or sent; reporting lands in P1-18."
            describedBy="report-action-hint"
          >
            Report user (preview)
          </PreviewAction>
        </div>
        <p className={surface.hint} id="block-action-hint" style={{ marginTop: "var(--space-3)" }}>
          The implemented block is silent to the blocked user. The blocker sees an explicit state,
          and new conversation or call attempts receive a generic unavailable response.
        </p>
        <p className={surface.hint} id="report-action-hint" style={{ marginTop: "var(--space-2)" }}>
          Reports will require an approved reason. Decrypted excerpts are optional, selected by the
          reporter, previewed before consent, and never attached automatically.
        </p>
      </section>

      <section aria-labelledby="profile-safety-title">
        <h2 className="u-section-title" id="profile-safety-title">
          Safety states
        </h2>
        <div className="u-grid" style={{ marginTop: "var(--space-3)" }}>
          <StatePanel
            kind="info"
            title="Blocked conversation"
            description="The blocker sees “You blocked this user” and cannot send. The blocked user sees no block disclosure; outbound sends fail with a generic unavailable state."
          />
          <StatePanel
            kind="unauthorized"
            title="Profile unavailable"
            description="Blocked users are omitted from discovery and cannot create a new conversation with the blocker. The response is neutral."
          />
        </div>
      </section>

      <p className="u-muted u-small">
        <Link href="/search">Back to search</Link> ·{" "}
        <Link href="/settings#blocked-users">Manage blocked users</Link>
      </p>
    </div>
  );
}
