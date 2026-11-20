export {
  InMemoryPresenceStore,
  resolveActivitySharingEnabled,
  type ActivityPreferencesRecord,
  type ConnectionDisconnectResult,
  type ConnectionTouchResult,
  type PresenceStore,
  type TypingSetInput,
  type TypingSetResult,
} from "./store.js";
export {
  computePresenceBroadcastsForUser,
  getConversationPeerPresence,
  handleConversationTypingSignal,
  isPresenceVisibleBetween,
  toActivityPreferencesView,
  type HandleTypingResult,
  type PeerPresenceBroadcastTarget,
  type PresenceServiceDependencies,
  type PresenceVisibilityReason,
} from "./service.js";
