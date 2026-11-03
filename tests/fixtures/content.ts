import type { Locale } from "@chat/contracts";

/**
 * Synthetic message content for localization, Unicode, and idempotency tests.
 *
 * The text is invented for the harness. It contains no real conversation,
 * personal data, or provider output.
 */
export type SyntheticLocale = Locale | "mixed";

export type SyntheticMessage = {
  readonly id: string;
  readonly conversationId: string;
  readonly authorId: string;
  readonly locale: SyntheticLocale;
  readonly body: string;
  readonly clientMessageId: string;
  readonly sentAt: string;
  readonly synthetic: true;
};

const conversationId = "synth-conversation-alpha-beta";

export const englishContent = {
  locale: "en",
  body: "The review notes are ready. Shall we read them together?",
} as const;

export const bengaliContent = {
  locale: "bn",
  body: "পর্যালোচনার নোটগুলো তৈরি। একসাথে পড়ব?",
} as const;

export const mixedUnicodeContent = {
  locale: "mixed",
  body: "নমস্কার 🌸 hello — কেমন আছ? 👩🏽‍💻",
} as const;

export const unicodeEdgeCases = {
  bengali: "আমি বাংলায় লিখি",
  emoji: "👩🏽‍💻",
  familyEmoji: "👨‍👩‍👧‍👦",
  combiningMark: "e\u0301",
  zeroWidthJoiner: "\u200d",
  nonBreakingSpace: "\u00a0",
  quoteAndDash: "“quoted” — dashed",
  longWord: "a".repeat(120),
} as const;

export const syntheticThread: ReadonlyArray<SyntheticMessage> = [
  {
    id: "synth-message-1",
    conversationId,
    authorId: "synth-user-alpha",
    locale: "en",
    body: englishContent.body,
    clientMessageId: "synth-client-message-1",
    sentAt: "2026-10-31T09:41:00.000Z",
    synthetic: true,
  },
  {
    id: "synth-message-2",
    conversationId,
    authorId: "synth-user-beta",
    locale: "bn",
    body: bengaliContent.body,
    clientMessageId: "synth-client-message-2",
    sentAt: "2026-10-31T09:42:00.000Z",
    synthetic: true,
  },
  {
    id: "synth-message-3",
    conversationId,
    authorId: "synth-user-alpha",
    locale: "mixed",
    body: mixedUnicodeContent.body,
    clientMessageId: "synth-client-message-3",
    sentAt: "2026-10-31T09:43:00.000Z",
    synthetic: true,
  },
];

/**
 * Same client-send identity and payload. A durable retry must resolve to the
 * original record instead of creating a second message.
 */
export const duplicateMessage: SyntheticMessage = syntheticThread[0]!;

/**
 * Same client-send identity with a changed payload. The contract maps this to
 * `IDEMPOTENCY_CONFLICT` and must not persist a second message.
 */
export const tamperedDuplicateMessage: SyntheticMessage = {
  ...syntheticThread[0]!,
  body: "Synthetic replacement payload that must not overwrite the accepted message.",
};
