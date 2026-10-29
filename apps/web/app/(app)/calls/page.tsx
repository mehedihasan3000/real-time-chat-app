import type { Metadata } from "next";
import Link from "next/link";

import { ActionLink } from "@/components/ui/action-link";
import { GeneratedAvatar } from "@/components/ui/avatar";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { StatePanel } from "@/components/ui/state-panel";
import surface from "@/components/ui/surface.module.css";
import { sampleCalls } from "@/lib/preview-data";

export const metadata: Metadata = {
  title: "Calls",
};

export default function CallsPage() {
  return (
    <div className="u-stack">
      <PageHeader
        eyebrow="Calling"
        title="Calls"
        description="Call history and call-detail surfaces for one-to-one audio and video calls. No media session exists."
        actions={
          <ActionLink href="/calls/sample-call" variant="secondary">
            Preview call detail
          </ActionLink>
        }
      />

      <PlaceholderNotice title="Calling is not implemented yet">
        <p>
          Signaling, WebRTC, microphone and camera permission handling, TURN credentials, and call
          lifecycle state land in Phase 3. This page does not request media access.
        </p>
      </PlaceholderNotice>

      <StatePanel
        kind="empty"
        title="No call history loaded"
        description="A new account has no calls. The sample rows below only demonstrate the planned history layout."
        action={
          <ActionLink href="/conversations/sample-conversation" variant="secondary">
            Preview a conversation
          </ActionLink>
        }
      />

      <section className={surface.card} aria-labelledby="sample-calls-title">
        <div className={surface.cardHeader}>
          <div>
            <h2 className={surface.cardTitle} id="sample-calls-title">
              Sample call history
            </h2>
            <p className={surface.cardDescription}>
              Synthetic records. They are not stored and do not represent real calls.
            </p>
          </div>
          <span className={surface.badge}>Static preview</span>
        </div>

        <ul className={surface.rowList}>
          {sampleCalls.map((call) => (
            <li className={surface.row} key={call.id}>
              <div className={surface.rowMain}>
                <GeneratedAvatar userId={`call-${call.id}`} name={call.name} size="sm" />
                <div>
                  <p className={surface.rowTitle}>{call.name}</p>
                  <p className={surface.rowMeta}>
                    {call.direction} · {call.kind} · {call.when} · {call.outcome}
                  </p>
                </div>
              </div>
              <Link className={surface.rowAction} href={`/calls/${call.id}`}>
                Open sample call
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="call-states-title">
        <h2 className="u-section-title" id="call-states-title">
          Call states represented in this shell
        </h2>
        <div className="u-grid" style={{ marginTop: "var(--space-3)" }}>
          <StatePanel
            kind="error"
            title="Permission denied"
            description="Denied microphone or camera access produces clear guidance and never a false connected state. No capture remains."
          />
          <StatePanel
            kind="disconnected"
            title="Reconnecting"
            description="A media or signaling interruption is shown as reconnecting under the approved timers; it is never concealed."
          />
          <StatePanel
            kind="unsupported"
            title="Relay unavailable"
            description="A relay-required network with unavailable TURN credentials fails safely with a relay-unavailable outcome."
          />
        </div>
      </section>
    </div>
  );
}
