import type { Metadata } from "next";
import Link from "next/link";

import { ActionLink } from "@/components/ui/action-link";
import { GeneratedAvatar } from "@/components/ui/avatar";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { StatePanel } from "@/components/ui/state-panel";
import surface from "@/components/ui/surface.module.css";
import { sampleConversation } from "@/lib/preview-data";

export const metadata: Metadata = {
  title: "Conversations",
};

export default function ConversationsPage() {
  return (
    <div className="u-stack">
      <PageHeader
        eyebrow="Messaging"
        title="Conversations"
        description="The conversation list and thread layout. No live data is loaded and no message can be sent."
        actions={
          <ActionLink href="/search" variant="secondary">
            Find someone
          </ActionLink>
        }
      />

      <PlaceholderNotice title="No live conversation data">
        <p>
          This preview has no database or realtime connection. The empty state below is the truthful
          state for a new account; the sample row only demonstrates the planned layout.
        </p>
      </PlaceholderNotice>

      <StatePanel
        kind="empty"
        title="No conversations yet"
        description="When messaging is implemented, conversations created from exact-username discovery will appear here."
        action={
          <ActionLink href="/search" variant="secondary">
            Search by username
          </ActionLink>
        }
      />

      <section className={surface.card} aria-labelledby="sample-conversations-title">
        <div className={surface.cardHeader}>
          <div>
            <h2 className={surface.cardTitle} id="sample-conversations-title">
              Sample conversation layout
            </h2>
            <p className={surface.cardDescription}>
              Synthetic content only. It is not stored, encrypted, or delivered.
            </p>
          </div>
          <span className={surface.badge}>Static preview</span>
        </div>

        <ul className={surface.rowList}>
          <li className={surface.row}>
            <div className={surface.rowMain}>
              <GeneratedAvatar
                userId={sampleConversation.participant.userId}
                name={sampleConversation.participant.name}
                size="sm"
              />
              <div>
                <p className={surface.rowTitle}>{sampleConversation.participant.name}</p>
                <p className={surface.rowMeta}>
                  @{sampleConversation.participant.username} · Sample message preview
                </p>
              </div>
            </div>
            <Link className={surface.rowAction} href={`/conversations/${sampleConversation.id}`}>
              Open sample conversation
            </Link>
          </li>
        </ul>
      </section>

      <section aria-labelledby="conversation-states-title">
        <h2 className="u-section-title" id="conversation-states-title">
          Conversation states represented in this shell
        </h2>
        <div className="u-grid" style={{ marginTop: "var(--space-3)" }}>
          <StatePanel
            kind="loading"
            title="Loading history"
            description="A request-scoped loading state with a safe retry path; no cached plaintext is implied."
          />
          <StatePanel
            kind="disconnected"
            title="Disconnected"
            description="The transport is unavailable. The shell must say so instead of showing a false connected state."
          />
          <StatePanel
            kind="error"
            title="History unavailable"
            description="A safe failure message with a correlation ID and a retry action; no stack trace or database detail."
          />
        </div>
      </section>
    </div>
  );
}
