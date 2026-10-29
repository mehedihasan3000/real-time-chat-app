import type { Metadata } from "next";
import Link from "next/link";

import { ActionLink } from "@/components/ui/action-link";
import { GeneratedAvatar } from "@/components/ui/avatar";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { StatePanel } from "@/components/ui/state-panel";
import surface from "@/components/ui/surface.module.css";
import { sampleProfile, sampleSelf } from "@/lib/preview-data";

export const metadata: Metadata = {
  title: "Your profile",
};

export default function ProfilePage() {
  return (
    <div className="u-stack">
      <PageHeader
        eyebrow="Account"
        title="Your profile"
        description="Preview the signed-in profile surface. No account data is loaded and no profile change can be saved."
        actions={
          <ActionLink href="/settings" variant="secondary">
            Open settings
          </ActionLink>
        }
      />

      <PlaceholderNotice title="Profile data is not loaded">
        <p>
          Display name, username, email, locale, timezone, and avatar preferences are placeholders.
          Profile loading and editing land in P1-17.
        </p>
      </PlaceholderNotice>

      <section className={surface.card} aria-labelledby="own-profile-title">
        <h2 className="visually-hidden" id="own-profile-title">
          Profile preview
        </h2>
        <div className={surface.profileCard}>
          <GeneratedAvatar
            userId={sampleSelf.userId}
            name={sampleSelf.name}
            size="lg"
            decorative={false}
          />
          <div>
            <p className={surface.profileName}>{sampleSelf.name}</p>
            <p className={surface.profileHandle}>@{sampleSelf.username}</p>
            <div className={surface.badgeRow} style={{ marginTop: "var(--space-2)" }}>
              <span className={surface.badge}>Generated avatar</span>
              <span className={surface.badge}>No upload</span>
              <span className={surface.badge}>Sample data</span>
            </div>
            <p className={surface.cardDescription} style={{ marginTop: "var(--space-3)" }}>
              {sampleSelf.bio}
            </p>
          </div>
        </div>

        <hr className={surface.divider} />

        <dl className={surface.metaGrid}>
          <div className={surface.metaItem}>
            <dt className={surface.metaTerm}>Email</dt>
            <dd className={surface.metaValue}>Not loaded</dd>
          </div>
          <div className={surface.metaItem}>
            <dt className={surface.metaTerm}>Username</dt>
            <dd className={surface.metaValue}>@{sampleSelf.username}</dd>
          </div>
          <div className={surface.metaItem}>
            <dt className={surface.metaTerm}>Locale</dt>
            <dd className={surface.metaValue}>{sampleSelf.locale}</dd>
          </div>
          <div className={surface.metaItem}>
            <dt className={surface.metaTerm}>Timezone</dt>
            <dd className={surface.metaValue}>{sampleSelf.timezone}</dd>
          </div>
        </dl>

        <div className={surface.actions} style={{ marginTop: "var(--space-5)" }}>
          <ActionLink href={`/profile/${sampleProfile.username}`} variant="secondary">
            View sample public profile
          </ActionLink>
          <ActionLink href="/settings#blocked-users" variant="ghost">
            Blocked users
          </ActionLink>
        </div>
      </section>

      <section aria-labelledby="profile-privacy-title">
        <h2 className="u-section-title" id="profile-privacy-title">
          Profile privacy
        </h2>
        <div className="u-grid" style={{ marginTop: "var(--space-3)" }}>
          <StatePanel
            kind="info"
            title="Generated initials only"
            description="The v1.0 avatar is generated from the display name with a deterministic colour. There is no upload, external image request, or third-party avatar provider."
          />
          <StatePanel
            kind="info"
            title="No profile persistence"
            description="This shell does not write preferences or profile fields. Locale and timezone storage depends on the P1-11 and P1-17 implementation scope."
          />
        </div>
      </section>

      <p className="u-muted u-small">
        Looking for someone else? <Link href="/search">Search by exact username</Link>.
      </p>
    </div>
  );
}
