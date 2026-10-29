import type { Metadata } from "next";
import Link from "next/link";

import { ActionLink } from "@/components/ui/action-link";
import { GeneratedAvatar } from "@/components/ui/avatar";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceholderNotice } from "@/components/ui/placeholder-notice";
import { PreviewAction } from "@/components/ui/preview-action";
import { StatePanel } from "@/components/ui/state-panel";
import surface from "@/components/ui/surface.module.css";
import { sampleConversation } from "@/lib/preview-data";

export const metadata: Metadata = {
  title: "Conversation preview",
};

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;

  if (conversationId !== sampleConversation.id) {
    return (
      <div className="u-stack">
        <PageHeader
          eyebrow="Messaging"
          title="Conversation preview"
          description="This route accepts a conversation ID, but the shell has no data source."
          actions={
            <ActionLink href="/conversations" variant="secondary">
              Back to conversations
            </ActionLink>
          }
        />
        <StatePanel
          kind="empty"
          title="No conversation data"
          description={`No conversation with the ID “${conversationId}” exists in this static preview. Only the labelled sample conversation is available.`}
          action={
            <ActionLink href={`/conversations/${sampleConversation.id}`} variant="secondary">
              Open the sample conversation
            </ActionLink>
          }
        />
      </div>
    );
  }

  return (
    <div className="u-stack">
      <PageHeader
        eyebrow="Conversation preview"
        title={sampleConversation.participant.name}
        description={`@${sampleConversation.participant.username} · Synthetic sample conversation`}
        actions={
          <>
            <ActionLink href="/conversations" variant="ghost">
              Back to list
            </ActionLink>
            <ActionLink href="/calls/sample-call" variant="secondary">
              Preview call screen
            </ActionLink>
          </>
        }
      />

      <PlaceholderNotice title="Messages are not live" tone="warning">
        <p>
          The messages below are synthetic layout samples. Sending, encryption, delivery, receipts,
          presence, typing, and history persistence are not implemented.
        </p>
      </PlaceholderNotice>

      <section className={surface.card} aria-labelledby="thread-title">
        <div className={surface.cardHeader}>
          <div className={surface.avatarRow}>
            <GeneratedAvatar
              userId={sampleConversation.participant.userId}
              name={sampleConversation.participant.name}
              size="sm"
            />
            <div>
              <h2 className={surface.cardTitle} id="thread-title">
                Thread preview
              </h2>
              <p className={surface.cardDescription}>Three synthetic sample messages</p>
            </div>
          </div>
          <span className={surface.badge}>Not connected</span>
        </div>

        <ol className={surface.messageList}>
          {sampleConversation.messages.map((message) => (
            <li className={surface.message} key={message.id}>
              <div className={surface.messageHeader}>
                <span className={surface.messageAuthor}>{message.author}</span>
                <span className={surface.messageTime}>{message.time} · sample</span>
              </div>
              <p className={surface.messageBody}>{message.body}</p>
            </li>
          ))}
        </ol>

        <div className={surface.composer}>
          <label className={surface.cardTitle} htmlFor="message-draft">
            Message
          </label>
          <textarea
            className={surface.textarea}
            id="message-draft"
            readOnly
            placeholder="Message composer preview — sending is not implemented"
            aria-describedby="message-draft-hint"
          />
          <p className={surface.hint} id="message-draft-hint">
            This field is read-only. The send control below only displays a preview notice; it does
            not create a message or contact a server.
          </p>
          <div className={surface.actions}>
            <PreviewAction
              message="Sending is not implemented. No message was created, encrypted, or delivered."
              describedBy="message-draft-hint"
            >
              Preview send
            </PreviewAction>
            <span className={surface.badge}>Unknown outcome is never shown as success</span>
          </div>
        </div>
      </section>

      <section aria-labelledby="thread-states-title">
        <h2 className="u-section-title" id="thread-states-title">
          Thread states
        </h2>
        <div className="u-grid" style={{ marginTop: "var(--space-3)" }}>
          <StatePanel
            kind="disconnected"
            title="Transport disconnected"
            description="The shell shows a local disconnected state and keeps the last known messages readable; it never claims a live connection."
          />
          <StatePanel
            kind="error"
            title="Unknown send outcome"
            description="An unknown outcome is not automatically a failure. The implemented client will reconcile with the original idempotency identity before offering a retry."
          />
          <StatePanel
            kind="unauthorized"
            title="Conversation inaccessible"
            description="A nonparticipant receives a safe rejection without conversation, message, or receipt data."
            action={<Link href="/sign-in">Sign-in screen</Link>}
          />
          <StatePanel
            kind="info"
            title="Presence and typing"
            description="Participant-only presence and typing indicators are planned. This shell shows no live presence and does not send typing events."
          />
          <StatePanel
            kind="info"
            title="Unread and read progress"
            description="Per-conversation unread counts and read progress are planned. No unread state is loaded or stored in this preview."
          />
          <StatePanel
            kind="info"
            title="Delivery and receipt labels"
            description="Sending, sent, delivered, read, failed, and unknown outcome are distinct labels. Delivery and read labels appear only after qualifying evidence; a queued or unknown outcome is never shown as delivered."
          />
        </div>
      </section>
    </div>
  );
}
