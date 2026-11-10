/**
 * Peer identity trust state (P2-01, FR-SEC-005 / DEC-002 §4.3).
 *
 * First contact is trust-on-first-use with a visible safety number. An
 * unexpected peer identity change clears verification and blocks sending
 * until the user explicitly accepts the new key. Acceptance unblocks sending
 * but does not claim out-of-band verification.
 */
export interface PeerKeyState {
  peerUserId: string;
  identityKey: string;
  firstSeenAt: string;
  changedAt: string | null;
  verified: boolean;
  verifiedAt: string | null;
  acceptedAt: string | null;
}

export type PeerKeyObservationStatus = "first-contact" | "unchanged" | "changed" | "accepted";

export interface PeerKeyObservation {
  status: PeerKeyObservationStatus;
  state: PeerKeyState;
  previousIdentityKey: string | null;
  sendAllowed: boolean;
  verificationRequired: boolean;
}

export function canSendToPeer(state: PeerKeyState | null): boolean {
  if (!state) return false;
  if (state.changedAt && !state.acceptedAt) return false;
  return true;
}

export function observePeerIdentity(
  previous: PeerKeyState | null,
  peerUserId: string,
  identityKey: string,
  now = new Date().toISOString(),
): PeerKeyObservation {
  if (!previous) {
    const state: PeerKeyState = {
      peerUserId,
      identityKey,
      firstSeenAt: now,
      changedAt: null,
      verified: false,
      verifiedAt: null,
      acceptedAt: null,
    };
    return {
      status: "first-contact",
      state,
      previousIdentityKey: null,
      sendAllowed: true,
      verificationRequired: true,
    };
  }

  if (previous.identityKey === identityKey) {
    return {
      status: "unchanged",
      state: previous,
      previousIdentityKey: previous.identityKey,
      sendAllowed: true,
      verificationRequired: !previous.verified,
    };
  }

  const state: PeerKeyState = {
    peerUserId,
    identityKey,
    firstSeenAt: now,
    changedAt: now,
    verified: false,
    verifiedAt: null,
    acceptedAt: null,
  };
  return {
    status: "changed",
    state,
    previousIdentityKey: previous.identityKey,
    sendAllowed: false,
    verificationRequired: true,
  };
}

/**
 * Explicitly accept the currently observed peer key. This clears the
 * key-change block but deliberately leaves `verified` false.
 */
export function acceptPeerKeyChange(
  previous: PeerKeyState | null,
  identityKey: string,
  now = new Date().toISOString(),
): PeerKeyObservation {
  if (!previous) {
    throw new Error("No observed peer key is available to accept.");
  }
  const state: PeerKeyState =
    previous.identityKey === identityKey
      ? { ...previous, acceptedAt: now }
      : {
          peerUserId: previous.peerUserId,
          identityKey,
          firstSeenAt: now,
          changedAt: now,
          verified: false,
          verifiedAt: null,
          acceptedAt: now,
        };
  return {
    status: "accepted",
    state,
    previousIdentityKey: previous.identityKey,
    sendAllowed: true,
    verificationRequired: !state.verified,
  };
}

/** Mark the accepted peer key as verified after out-of-band comparison. */
export function markPeerVerified(
  previous: PeerKeyState | null,
  now = new Date().toISOString(),
): PeerKeyObservation {
  if (!previous) throw new Error("No observed peer key is available to verify.");
  if (previous.changedAt && !previous.acceptedAt) {
    throw new Error("Accept the peer key change before marking it verified.");
  }
  const state: PeerKeyState = {
    ...previous,
    verified: true,
    verifiedAt: now,
    acceptedAt: previous.acceptedAt ?? now,
  };
  return {
    status: "unchanged",
    state,
    previousIdentityKey: previous.identityKey,
    sendAllowed: true,
    verificationRequired: false,
  };
}

export interface PeerKeyStore {
  get(peerUserId: string): PeerKeyState | null;
  set(state: PeerKeyState): void;
  delete(peerUserId: string): void;
}

export class MemoryPeerKeyStore implements PeerKeyStore {
  private readonly states = new Map<string, PeerKeyState>();

  get(peerUserId: string): PeerKeyState | null {
    return this.states.get(peerUserId) ?? null;
  }

  set(state: PeerKeyState): void {
    this.states.set(state.peerUserId, state);
  }

  delete(peerUserId: string): void {
    this.states.delete(peerUserId);
  }
}

export class PeerKeyGuard {
  constructor(
    private readonly store: PeerKeyStore = new MemoryPeerKeyStore(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  observe(peerUserId: string, identityKey: string): PeerKeyObservation {
    const previous = this.store.get(peerUserId);
    const observation = observePeerIdentity(
      previous,
      peerUserId,
      identityKey,
      this.now().toISOString(),
    );
    this.store.set(observation.state);
    return observation;
  }

  accept(peerUserId: string): PeerKeyObservation {
    const previous = this.store.get(peerUserId);
    if (!previous) throw new Error("No observed peer key is available to accept.");
    const observation = acceptPeerKeyChange(
      previous,
      previous.identityKey,
      this.now().toISOString(),
    );
    this.store.set(observation.state);
    return observation;
  }

  markVerified(peerUserId: string): PeerKeyObservation {
    const previous = this.store.get(peerUserId);
    const observation = markPeerVerified(previous, this.now().toISOString());
    this.store.set(observation.state);
    return observation;
  }

  canSend(peerUserId: string): boolean {
    return canSendToPeer(this.store.get(peerUserId));
  }

  get(peerUserId: string): PeerKeyState | null {
    return this.store.get(peerUserId);
  }

  clear(peerUserId: string): void {
    this.store.delete(peerUserId);
  }
}
