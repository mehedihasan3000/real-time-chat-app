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
      author: "Nusrat Jahan",
      time: "09:41",
      body: "This is a synthetic sample message. It previews the conversation layout without using real content.",
    },
    {
      id: "sample-message-2",
      author: "Sample User",
      time: "09:42",
      body: "The composer below is a preview. Sending, delivery, receipts, and encryption are not implemented yet.",
    },
    {
      id: "sample-message-3",
      author: "Nusrat Jahan",
      time: "09:43",
      body: "Loading, empty, error, and disconnected states are documented in the UI state gallery.",
    },
  ],
} as const;

export const sampleSelf = {
  userId: "preview-self",
  name: "Sample User",
  username: "sample_user",
  bio: "Synthetic profile used to preview the signed-in profile layout.",
  locale: "English (provisional)",
  timezone: "Not set",
} as const;

export const sampleProfile = {
  userId: "preview-nusrat",
  name: "Nusrat Jahan",
  username: "nusrat_j",
  bio: "Synthetic profile used to preview the public profile layout.",
  locale: "English (provisional)",
  timezone: "Not set",
} as const;

export const sampleCalls = [
  {
    id: "sample-call",
    name: "Nusrat Jahan",
    username: "nusrat_j",
    kind: "Video call",
    direction: "Outgoing",
    when: "Today, 09:35",
    duration: "4 min 12 s",
    outcome: "Completed (sample)",
  },
  {
    id: "sample-call-missed",
    name: "Nusrat Jahan",
    username: "nusrat_j",
    kind: "Audio call",
    direction: "Incoming",
    when: "Yesterday, 18:10",
    duration: "Not connected",
    outcome: "Missed (sample)",
  },
] as const;

export const sampleCall = sampleCalls[0];
