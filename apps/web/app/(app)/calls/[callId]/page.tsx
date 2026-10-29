import type { Metadata } from "next";
import Link from "next/link";

import { ActionLink } from "@/components/ui/action-link";
import { GeneratedAvatar } from "@/components/ui/avatar";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PreviewAction } from "@/components/ui/preview-action";
import { StatePanel } from "@/components/ui/state-panel";
import surface from "@/components/ui/surface.module.css";
import { sampleCall, sampleCalls } from "@/lib/preview-data";

export const metadata: Metadata = {
  title: "Call preview",
};

export default async function CallPage({ params }: { params: Promise<{ callId: string }> }) {
  const { callId } = await params;
  const call = sampleCalls.find((entry) => entry.id === callId);

  if (!call) {
    return (
      <div className="u-stack">
        <PageHeader
          eyebrow="Calling"
          title="Call preview"
          description="This route accepts a call ID, but the shell has no call data source."
          actions={
            <ActionLink href="/calls" variant="secondary">
              Back to calls
            </ActionLink>
          }
        />
        <StatePanel
          kind="empty"
          title="No call data"
          description={`No call with the ID “${callId}” exists in this static preview. Only the labelled sample call is available.`}
          action={
            <ActionLink href={`/calls/${sampleCall.id}`} variant="secondary">
              Open the sample call
            </ActionLink>
          }
        />
      </div>
    );
  }

  return (
    <div className="u-stack">
      <PageHeader
        eyebrow="Call preview"
        title={call.name}
        description={`@${call.username} · Synthetic sample call record`}
        actions={
          <ActionLink href="/calls" variant="secondary">
            Back to calls
          </ActionLink>
        }
      />

      <PlaceholderNotice title="No media session exists" tone="warning">
        <p>
          This is a static record. No camera or microphone access is requested, no signaling or peer
          connection is created, and the controls below only display preview notices.
        </p>
      </PlaceholderNotice>

      <section className={surface.card} aria-labelledby="call-summary-title">
        <div className={surface.cardHeader}>
          <div className={surface.avatarRow}>
            <GeneratedAvatar
              userId={`call-${call.id}`}
              name={call.name}
              size="md"
              decorative={false}
            />
            <div>
              <h2 className={surface.cardTitle} id="call-summary-title">
                Call summary
              </h2>
              <p className={surface.cardDescription}>Sample lifecycle record</p>
            </div>
          </div>
          <span className={surface.badge}>{call.outcome}</span>
        </div>

        <dl className={surface.metaGrid}>
          <div className={surface.metaItem}>
            <dt className={surface.metaTerm}>Direction</dt>
            <dd className={surface.metaValue}>{call.direction}</dd>
          </div>
          <div className={surface.metaItem}>
            <dt className={surface.metaTerm}>Type</dt>
            <dd className={surface.metaValue}>{call.kind}</dd>
          </div>
          <div className={surface.metaItem}>
            <dt className={surface.metaTerm}>Started</dt>
            <dd className={surface.metaValue}>{call.when}</dd>
          </div>
          <div className={surface.metaItem}>
            <dt className={surface.metaTerm}>Duration</dt>
            <dd className={surface.metaValue}>{call.duration}</dd>
          </div>
          <div className={surface.metaItem}>
            <dt className={surface.metaTerm}>Outcome</dt>
            <dd className={surface.metaValue}>{call.outcome}</dd>
          </div>
          <div className={surface.metaItem}>
            <dt className={surface.metaTerm}>Media</dt>
            <dd className={surface.metaValue}>No recording or raw media stored</dd>
          </div>
        </dl>
      </section>

      <section className={surface.card} aria-labelledby="call-controls-title">
        <h2 className={surface.cardTitle} id="call-controls-title">
          Media controls preview
        </h2>
        <p className={surface.cardDescription}>
          Controls are shown with their intended labels and states. They do not access devices or
          change a call.
        </p>
        <div className={surface.actions} style={{ marginTop: "var(--space-4)" }}>
          <PreviewAction
            message="Microphone control is not implemented. No device permission was requested and no audio track exists."
            describedBy="call-controls-hint"
          >
            Mute microphone (preview)
          </PreviewAction>
          <PreviewAction
            message="Camera control is not implemented. No device permission was requested and no video track exists."
            describedBy="call-controls-hint"
          >
            Turn camera off (preview)
          </PreviewAction>
          <PreviewAction
            message="Ending a call is not implemented. There is no active call and no server request was made."
            variant="danger"
            describedBy="call-controls-hint"
          >
            End call (preview)
          </PreviewAction>
        </div>
        <p className={surface.hint} id="call-controls-hint" style={{ marginTop: "var(--space-3)" }}>
          The implemented UI will match the actual track state. A muted track or denied permission
          is never shown as connected.
        </p>
      </section>

      <section aria-labelledby="call-detail-states-title">
        <h2 className="u-section-title" id="call-detail-states-title">
          Failure and disruption states
        </h2>
        <div className="u-grid" style={{ marginTop: "var(--space-3)" }}>
          <StatePanel
            kind="error"
            title="Microphone or camera permission denied"
            description="The call fails with a permission-denied outcome, shows clear guidance, and releases any capture."
          />
          <StatePanel
            kind="disconnected"
            title="Media path interrupted"
            description="The local UI shows reconnecting and applies the approved reconnect-or-end policy instead of pretending the call is healthy."
          />
          <StatePanel
            kind="unsupported"
            title="TURN relay unavailable"
            description="On a relay-required network, missing or failed TURN credentials produce an explicit relay-unavailable failure."
            action={<Link href="/states">View all UI states</Link>}
          />
          <StatePanel
            kind="info"
            title="Call lifecycle states"
            description="Ringing, connecting, connected, reconnecting, and terminal states are distinct. Delayed events cannot revive a terminal call, and local media state is shown separately from server state."
          />
        </div>
      </section>
    </div>
  );
}
