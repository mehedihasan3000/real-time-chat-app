import type { Metadata } from "next";
import Link from "next/link";

import { ActionLink } from "@/components/ui/action-link";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { StatePanel } from "@/components/ui/state-panel";

export const metadata: Metadata = {
  title: "UI states",
};

export default function StatesPage() {
  return (
    <div className="u-stack">
      <PageHeader
        eyebrow="Design reference"
        title="UI states"
        description="A static gallery of the shared states used across the shell. Each panel is illustrative; none reports live status."
        actions={
          <ActionLink href="/" variant="secondary">
            Back home
          </ActionLink>
        }
      />

      <PlaceholderNotice title="Static gallery">
        <p>
          These panels show the wording and structure required by the error model. They are not
          triggered by a request, socket, provider, or media device on this page.
        </p>
      </PlaceholderNotice>

      <section aria-labelledby="state-gallery-title">
        <h2 className="u-section-title" id="state-gallery-title">
          Shared states
        </h2>
        <div className="u-grid" style={{ marginTop: "var(--space-3)" }}>
          <StatePanel
            kind="loading"
            title="Loading"
            description="Used for request-scoped progress. The implemented view names the operation and offers cancellation where the contract supports it."
          />
          <StatePanel
            kind="empty"
            title="Empty"
            description="Used when a valid request has no results. The copy stays neutral and offers a safe next action."
            action={<Link href="/search">Search by username</Link>}
          />
          <StatePanel
            kind="error"
            title="Error"
            description="Used for a safe failure with a correlation ID and a retry path. Stack traces, database internals, and raw provider errors are never shown."
          />
          <StatePanel
            kind="disconnected"
            title="Disconnected"
            description="Used when the transport or media path is unavailable. The UI says so and never keeps a false connected state."
          />
          <StatePanel
            kind="unauthorized"
            title="Access required"
            description="Used for an expired session or an inaccessible resource. The approved contract decides when the response is deliberately uniform."
            action={<Link href="/sign-in">Open sign-in</Link>}
          />
          <StatePanel
            kind="unsupported"
            title="Unsupported"
            description="Used for an unsupported capability, browser feature, AI release gate, or relay-required network without TURN."
          />
          <StatePanel
            kind="info"
            title="Information"
            description="Used for non-error context such as pending verification, preview limitations, or privacy disclosures."
          />
          <StatePanel
            kind="error"
            title="Key recovery required"
            description="Used when a device key is missing or lost. The user needs the recovery flow, and the UI must not promise recovery that the reviewed key lifecycle cannot provide."
          />
          <StatePanel
            kind="info"
            title="Permission change required"
            description="Used when browser microphone or camera permission was denied. The user must change the browser permission before a new call attempt; the shell never leaves a false connected state."
          />
        </div>
      </section>

      <section aria-labelledby="state-map-title">
        <h2 className="u-section-title" id="state-map-title">
          Where the states appear
        </h2>
        <ul className="u-list u-muted">
          <li>
            <Link href="/conversations">Conversations</Link>: empty list, loading history,
            disconnected transport, and history failure.
          </li>
          <li>
            <Link href="/conversations/sample-conversation">Conversation detail</Link>: unknown send
            outcome, disconnected transport, and inaccessible conversation.
          </li>
          <li>
            <Link href="/search">Search</Link>: neutral no-result, unsupported search mode, and
            sign-in required.
          </li>
          <li>
            <Link href="/calls">Calls</Link> and <Link href="/calls/sample-call">call detail</Link>:
            permission denied, reconnecting, and relay unavailable.
          </li>
          <li>
            <Link href="/ai">AI</Link>: request progress, provider failure, and missing consent or
            authorization.
          </li>
          <li>
            <Link href="/sign-in">Authentication</Link>: pending verification, generic recovery
            response, and preview-only notices.
          </li>
        </ul>
      </section>
    </div>
  );
}
