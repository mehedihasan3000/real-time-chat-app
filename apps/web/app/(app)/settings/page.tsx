import type { Metadata } from "next";
import Link from "next/link";

import { ActionLink } from "@/components/ui/action-link";
import { GeneratedAvatar } from "@/components/ui/avatar";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PreviewAction } from "@/components/ui/preview-action";
import surface from "@/components/ui/surface.module.css";
import { sampleSelf } from "@/lib/preview-data";

export const metadata: Metadata = {
  title: "Settings",
};

export default function SettingsPage() {
  return (
    <div className="u-stack">
      <PageHeader
        eyebrow="Preferences"
        title="Settings"
        description="Preview the account, privacy, language, data, and session settings. No preference is saved."
        actions={
          <ActionLink href="/profile" variant="secondary">
            View profile
          </ActionLink>
        }
      />

      <PlaceholderNotice title="Settings are not saved">
        <p>
          There is no session, preference store, or account API in this shell. Controls are disabled
          or display a preview notice. The related implementation tasks are P1-11, P1-17, and P1-18.
        </p>
      </PlaceholderNotice>

      <nav className={surface.sectionNav} aria-label="Settings sections">
        <ul className={surface.sectionNavList}>
          <li>
            <a href="#account">Account</a>
          </li>
          <li>
            <a href="#profile-settings">Profile</a>
          </li>
          <li>
            <a href="#privacy">Privacy</a>
          </li>
          <li>
            <a href="#blocked-users">Blocked users</a>
          </li>
          <li>
            <a href="#language-time">Language and time</a>
          </li>
          <li>
            <a href="#data-sessions">Data and sessions</a>
          </li>
        </ul>
      </nav>

      <section className={surface.card} id="account" aria-labelledby="account-title">
        <h2 className={surface.cardTitle} id="account-title">
          Account
        </h2>
        <p className={surface.cardDescription}>
          Session and account data are not loaded. Sign-out behavior is part of P1-06.
        </p>
        <dl className={surface.metaGrid} style={{ marginTop: "var(--space-4)" }}>
          <div className={surface.metaItem}>
            <dt className={surface.metaTerm}>Email</dt>
            <dd className={surface.metaValue}>Not loaded</dd>
          </div>
          <div className={surface.metaItem}>
            <dt className={surface.metaTerm}>Email verification</dt>
            <dd className={surface.metaValue}>Unknown — auth is not implemented</dd>
          </div>
          <div className={surface.metaItem}>
            <dt className={surface.metaTerm}>Session</dt>
            <dd className={surface.metaValue}>No session in this preview</dd>
          </div>
        </dl>
        <div className={surface.actions} style={{ marginTop: "var(--space-4)" }}>
          <PreviewAction
            message="Sign out is not implemented. No session exists and no request was made."
            describedBy="sign-out-hint"
          >
            Sign out (preview)
          </PreviewAction>
        </div>
        <p className={surface.hint} id="sign-out-hint" style={{ marginTop: "var(--space-2)" }}>
          The implemented flow will revoke the Better Auth session and clear the in-memory token.
        </p>
      </section>

      <section
        className={surface.card}
        id="profile-settings"
        aria-labelledby="profile-settings-title"
      >
        <h2 className={surface.cardTitle} id="profile-settings-title">
          Profile
        </h2>
        <p className={surface.cardDescription}>
          Display name, username, and avatar editing land in P1-17. The avatar is generated from
          initials; there is no upload.
        </p>
        <div className={surface.avatarRow} style={{ marginTop: "var(--space-4)" }}>
          <GeneratedAvatar
            userId={sampleSelf.userId}
            name={sampleSelf.name}
            size="md"
            decorative={false}
          />
          <div>
            <p className={surface.rowTitle}>{sampleSelf.name}</p>
            <p className={surface.rowMeta}>@{sampleSelf.username}</p>
          </div>
        </div>
        <div className={surface.actions} style={{ marginTop: "var(--space-4)" }}>
          <ActionLink href="/profile" variant="secondary">
            Open profile preview
          </ActionLink>
        </div>
      </section>

      <section className={surface.card} id="privacy" aria-labelledby="privacy-title">
        <h2 className={surface.cardTitle} id="privacy-title">
          Privacy
        </h2>
        <p className={surface.cardDescription}>
          Privacy controls are placeholders. No consent, receipt preference, or block record is
          stored.
        </p>
        <ul className={surface.controlList} style={{ marginTop: "var(--space-4)" }}>
          <li className={surface.controlRow}>
            <div className={surface.controlCopy}>
              <p className={surface.controlLabel}>Read receipts</p>
              <p className={surface.controlHint} id="receipts-hint">
                Opt-in and default off. Sending receipts is reciprocal once enabled. Not saved in
                this preview.
              </p>
            </div>
            <label className={surface.checkboxRow} htmlFor="read-receipts">
              <input id="read-receipts" type="checkbox" disabled aria-describedby="receipts-hint" />
              <span>Disabled preview</span>
            </label>
          </li>
          <li className={surface.controlRow}>
            <div className={surface.controlCopy}>
              <p className={surface.controlLabel}>AI processing</p>
              <p className={surface.controlHint} id="ai-privacy-hint">
                Real-content AI is release-gated. No per-action consent is recorded in this shell.
              </p>
            </div>
            <Link href="/ai">Open AI surfaces</Link>
          </li>
        </ul>
      </section>

      <section className={surface.card} id="blocked-users" aria-labelledby="blocked-users-title">
        <h2 className={surface.cardTitle} id="blocked-users-title">
          Blocked users
        </h2>
        <p className={surface.cardDescription}>
          No blocked users are loaded. Blocking, unblocking, and reporting land in P1-18.
        </p>
        <div className={surface.actions} style={{ marginTop: "var(--space-4)" }}>
          <ActionLink href="/profile/nusrat_j" variant="secondary">
            Preview a profile with safety actions
          </ActionLink>
        </div>
      </section>

      <section className={surface.card} id="language-time" aria-labelledby="language-time-title">
        <h2 className={surface.cardTitle} id="language-time-title">
          Language and time
        </h2>
        <p className={surface.cardDescription}>
          English and Bengali catalogs, locale-aware timestamps, and timezone storage are not
          implemented. The selector is disabled and provisional.
        </p>
        <div className="u-stack" style={{ marginTop: "var(--space-4)", gap: "var(--space-4)" }}>
          <div>
            <label className={surface.controlLabel} htmlFor="interface-language">
              Interface language
            </label>
            <p className={surface.controlHint} id="interface-language-hint">
              P1-11 adds the English/Bengali catalogs. The current copy is English only.
            </p>
            <select
              className={surface.select}
              id="interface-language"
              disabled
              aria-describedby="interface-language-hint"
              defaultValue="en"
              style={{ marginTop: "var(--space-2)" }}
            >
              <option value="en">English</option>
              <option value="bn" lang="bn">
                বাংলা
              </option>
            </select>
          </div>
          <div>
            <label className={surface.controlLabel} htmlFor="display-timezone">
              Display timezone
            </label>
            <p className={surface.controlHint} id="display-timezone-hint">
              The implemented preference will use an IANA timezone with a UTC fallback.
            </p>
            <input
              className={surface.select}
              id="display-timezone"
              type="text"
              disabled
              placeholder="Not set"
              aria-describedby="display-timezone-hint"
              style={{ marginTop: "var(--space-2)" }}
            />
          </div>
        </div>
      </section>

      <section className={surface.card} id="data-sessions" aria-labelledby="data-sessions-title">
        <h2 className={surface.cardTitle} id="data-sessions-title">
          Data and sessions
        </h2>
        <p className={surface.cardDescription}>
          Export, deletion, and session revocation are not implemented. The descriptions below
          reflect the recorded policy, not an enabled feature.
        </p>
        <ul className={surface.controlList} style={{ marginTop: "var(--space-4)" }}>
          <li className={surface.controlRow}>
            <div className={surface.controlCopy}>
              <p className={surface.controlLabel}>Export account data</p>
              <p className={surface.controlHint} id="export-hint">
                The planned export is an encrypted recovery archive. A server-side plaintext export
                is not advertised.
              </p>
            </div>
            <PreviewAction
              message="Export is not implemented. No archive was created and no data was read."
              describedBy="export-hint"
            >
              Export (preview)
            </PreviewAction>
          </li>
          <li className={surface.controlRow}>
            <div className={surface.controlCopy}>
              <p className={surface.controlLabel}>Delete account</p>
              <p className={surface.controlHint} id="delete-account-hint">
                The recorded flow uses a 7-day grace period and a tombstone; recipient local copies
                cannot be recalled.
              </p>
            </div>
            <PreviewAction
              message="Account deletion is not implemented. No deletion request was recorded."
              variant="danger"
              describedBy="delete-account-hint"
            >
              Delete account (preview)
            </PreviewAction>
          </li>
          <li className={surface.controlRow}>
            <div className={surface.controlCopy}>
              <p className={surface.controlLabel}>Other sessions</p>
              <p className={surface.controlHint} id="other-sessions-hint">
                There is no session store in this shell. Revoking other sessions will be part of the
                auth implementation.
              </p>
            </div>
            <PreviewAction
              message="Session revocation is not implemented. No session was revoked."
              describedBy="other-sessions-hint"
            >
              Revoke other sessions (preview)
            </PreviewAction>
          </li>
        </ul>
      </section>
    </div>
  );
}
