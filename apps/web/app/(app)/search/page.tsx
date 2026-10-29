import type { Metadata } from "next";
import Link from "next/link";

import { ActionLink } from "@/components/ui/action-link";
import { GeneratedAvatar } from "@/components/ui/avatar";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PreviewForm } from "@/components/ui/preview-form";
import { StatePanel } from "@/components/ui/state-panel";
import surface from "@/components/ui/surface.module.css";
import { sampleProfile } from "@/lib/preview-data";

export const metadata: Metadata = {
  title: "Search",
};

export default function SearchPage() {
  return (
    <div className="u-stack">
      <PageHeader
        eyebrow="Discovery"
        title="Find people"
        description="Discovery is authenticated and limited to an exact, normalized username. Prefix, email, and phone search are intentionally unsupported."
        actions={
          <ActionLink href="/conversations" variant="secondary">
            Back to conversations
          </ActionLink>
        }
      />

      <PlaceholderNotice title="Search is not implemented yet">
        <p>
          Exact-username lookup, neutral no-result behavior, and blocked-user omission land in
          P1-17. This form does not call an API and does not disclose whether an account exists.
        </p>
      </PlaceholderNotice>

      <section className={surface.card} aria-labelledby="search-form-title">
        <h2 className={surface.cardTitle} id="search-form-title">
          Exact username search
        </h2>
        <p className={surface.cardDescription}>
          Usernames are 3–24 ASCII characters, start with a letter, and contain only lowercase
          letters, digits, and underscores.
        </p>
        <div style={{ marginTop: "var(--space-4)" }}>
          <PreviewForm
            fields={[
              {
                name: "username",
                label: "Username",
                type: "search",
                autoComplete: "off",
                required: true,
                minLength: 3,
                maxLength: 24,
                placeholder: "exact_username",
                hint: "The implemented search returns only userId, username, display name, and avatar reference.",
              },
            ]}
            submitLabel="Preview search"
            statusMessage="Preview only: no search request was made. Exact-username discovery is implemented in P1-17."
          />
        </div>
      </section>

      <section className={surface.card} aria-labelledby="sample-result-title">
        <div className={surface.cardHeader}>
          <div>
            <h2 className={surface.cardTitle} id="sample-result-title">
              Sample result layout
            </h2>
            <p className={surface.cardDescription}>
              Synthetic result. It is not returned by a search and does not represent a real
              account.
            </p>
          </div>
          <span className={surface.badge}>Static preview</span>
        </div>
        <ul className={surface.rowList}>
          <li className={surface.row}>
            <div className={surface.rowMain}>
              <GeneratedAvatar userId={sampleProfile.userId} name={sampleProfile.name} size="sm" />
              <div>
                <p className={surface.rowTitle}>{sampleProfile.name}</p>
                <p className={surface.rowMeta}>@{sampleProfile.username}</p>
              </div>
            </div>
            <Link className={surface.rowAction} href={`/profile/${sampleProfile.username}`}>
              View sample profile
            </Link>
          </li>
        </ul>
      </section>

      <section aria-labelledby="search-states-title">
        <h2 className="u-section-title" id="search-states-title">
          Search states
        </h2>
        <div className="u-grid" style={{ marginTop: "var(--space-3)" }}>
          <StatePanel
            kind="empty"
            title="No exact match"
            description="The implemented response is neutral and does not reveal whether an account exists."
          />
          <StatePanel
            kind="unsupported"
            title="Unsupported search modes"
            description="Prefix search, email lookup, phone lookup, and “people you may know” are not part of v1.0."
          />
          <StatePanel
            kind="unauthorized"
            title="Sign-in required"
            description="Discovery is authenticated. This static preview is visible, but the implemented route will require a session."
            action={<Link href="/sign-in">Open sign-in</Link>}
          />
        </div>
      </section>
    </div>
  );
}
