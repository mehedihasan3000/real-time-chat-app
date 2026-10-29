import type { Metadata } from "next";

import { ActionLink } from "@/components/ui/action-link";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { StatePanel } from "@/components/ui/state-panel";
import surface from "@/components/ui/surface.module.css";

export const metadata: Metadata = {
  title: "AI assistance",
};

const features = [
  {
    title: "Smart replies",
    description:
      "Suggestions generated only from the selected message context. The user can review, edit, copy, or discard a suggestion; nothing is sent automatically.",
  },
  {
    title: "Message translation",
    description:
      "A selected message translated into an approved target language. The translation is labelled separately and the original stays unchanged.",
  },
  {
    title: "Conversation summary",
    description:
      "A summary of a bounded, user-selected conversation range. It is displayed separately with a notice that it may omit or misstate information.",
  },
] as const;

export default function AiPage() {
  return (
    <div className="u-stack">
      <PageHeader
        eyebrow="AI features"
        title="AI assistance"
        description="Informational placeholders for smart replies, translation, and summaries. Real-content AI is disabled."
        actions={
          <ActionLink href="/settings#privacy" variant="secondary">
            Privacy settings
          </ActionLink>
        }
      />

      <PlaceholderNotice title="Release-gated: real-content AI is disabled" tone="warning">
        <p>
          DEC-026 requires privacy and legal sign-off, per-action consent, disclosure, and
          provider-integration evidence before real message content is processed. No consent is
          recorded here, no content is sent, and no AI provider is called.
        </p>
      </PlaceholderNotice>

      <StatePanel
        kind="unsupported"
        title="AI assistance is unavailable"
        description="The three AI features are MVP capabilities, but this shell exposes only their surfaces. Provider failure must never block authentication, history, or calls."
        action={
          <ActionLink href="/states" variant="secondary">
            View all UI states
          </ActionLink>
        }
      />

      <section aria-labelledby="ai-features-title">
        <h2 className="u-section-title" id="ai-features-title">
          Planned AI surfaces
        </h2>
        <div className="u-grid" style={{ marginTop: "var(--space-3)" }}>
          {features.map((feature) => (
            <article className={surface.card} key={feature.title}>
              <div className={surface.cardHeader}>
                <h3 className={surface.cardTitle}>{feature.title}</h3>
                <span className={surface.badge}>Not available</span>
              </div>
              <p className={surface.cardDescription}>{feature.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="ai-states-title">
        <h2 className="u-section-title" id="ai-states-title">
          AI states represented in this shell
        </h2>
        <div className="u-grid" style={{ marginTop: "var(--space-3)" }}>
          <StatePanel
            kind="loading"
            title="Request-scoped progress"
            description="Each AI operation has its own loading and cancellation state. Cancellation prevents a later result from being inserted automatically."
          />
          <StatePanel
            kind="error"
            title="Provider failure"
            description="A safe failure message with a deliberate retry option. Original messages remain accessible and core chat is unaffected."
          />
          <StatePanel
            kind="unauthorized"
            title="Consent or authorization missing"
            description="No AI request is made without the current participant context and per-action consent for the selected content."
          />
        </div>
      </section>
    </div>
  );
}
