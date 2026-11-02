import type { MessageKey } from "@/src/i18n/catalog";

/**
 * Synthetic sample records. Times are stored as UTC instants and formatted
 * only at render time for the selected locale and disclosed display timezone.
 */
export const sampleConversation = {
  id: "sample-conversation",
  participant: {
    userId: "preview-nusrat",
    name: "Nusrat Jahan",
    username: "nusrat_j",
  },
  messages: [
    {
      id: "sample-message-1",
      authorId: "preview-nusrat",
      authorName: "Nusrat Jahan",
      sentAt: "2026-10-31T09:41:00.000Z",
      bodyKey: "sample.call.message1",
      outgoing: false,
    },
    {
      id: "sample-message-2",
      authorId: "preview-self",
      authorName: "Sample User",
      sentAt: "2026-10-31T09:42:00.000Z",
      bodyKey: "sample.call.message2",
      outgoing: true,
    },
    {
      id: "sample-message-3",
      authorId: "preview-nusrat",
      authorName: "Nusrat Jahan",
      sentAt: "2026-10-31T09:43:00.000Z",
      bodyKey: "sample.call.message3",
      outgoing: false,
    },
  ],
} as const satisfies {
  id: string;
  participant: { userId: string; name: string; username: string };
  messages: ReadonlyArray<{
    id: string;
    authorId: string;
    authorName: string;
    sentAt: string;
    bodyKey: MessageKey;
    outgoing: boolean;
  }>;
};

export const sampleSelf = {
  userId: "preview-self",
  name: "Sample User",
  username: "sample_user",
  bioKey: "sample.call.selfBio",
} as const;

export const sampleProfile = {
  userId: "preview-nusrat",
  name: "Nusrat Jahan",
  username: "nusrat_j",
  bioKey: "sample.call.profileBio",
} as const;

export type SampleCall = {
  id: string;
  userId: string;
  name: string;
  username: string;
  kindKey: MessageKey;
  directionKey: MessageKey;
  startedAt: string;
  durationSeconds: number | null;
  outcomeKey: MessageKey;
  missed: boolean;
};

export const sampleCalls: ReadonlyArray<SampleCall> = [
  {
    id: "sample-call",
    userId: "preview-nusrat",
    name: "Nusrat Jahan",
    username: "nusrat_j",
    kindKey: "sample.call.video",
    directionKey: "sample.call.outgoing",
    startedAt: "2026-10-31T09:35:00.000Z",
    durationSeconds: 252,
    outcomeKey: "sample.call.completed",
    missed: false,
  },
  {
    id: "sample-call-missed",
    userId: "preview-nusrat",
    name: "Nusrat Jahan",
    username: "nusrat_j",
    kindKey: "sample.call.audio",
    directionKey: "sample.call.incoming",
    startedAt: "2026-10-30T18:10:00.000Z",
    durationSeconds: null,
    outcomeKey: "sample.call.missed",
    missed: true,
  },
];

export const sampleCall = sampleCalls[0] as SampleCall;

export function findSampleCall(callId: string): SampleCall | undefined {
  return sampleCalls.find((call) => call.id === callId);
}
