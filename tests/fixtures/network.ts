/**
 * Synthetic network profiles for direct and forced-relay coverage.
 *
 * No socket, WebRTC peer connection, TURN server, or media stream is created by
 * these fixtures. They only standardize the inputs a later integration suite
 * needs so direct and relay paths cannot be silently conflated.
 */
export type NetworkProfile = {
  readonly id: "direct" | "relay" | "relay-lossy";
  readonly label: string;
  readonly forceRelay: boolean;
  readonly iceTransportPolicy: "all" | "relay";
  readonly latencyMs: number;
  readonly packetLossPercent: number;
  readonly synthetic: true;
};

export const directNetworkProfile = {
  id: "direct",
  label: "Direct peer path",
  forceRelay: false,
  iceTransportPolicy: "all",
  latencyMs: 25,
  packetLossPercent: 0,
  synthetic: true,
} as const satisfies NetworkProfile;

export const relayNetworkProfile = {
  id: "relay",
  label: "Forced relay path",
  forceRelay: true,
  iceTransportPolicy: "relay",
  latencyMs: 120,
  packetLossPercent: 0,
  synthetic: true,
} as const satisfies NetworkProfile;

export const relayLossyNetworkProfile = {
  id: "relay-lossy",
  label: "Forced relay path with synthetic loss",
  forceRelay: true,
  iceTransportPolicy: "relay",
  latencyMs: 180,
  packetLossPercent: 2,
  synthetic: true,
} as const satisfies NetworkProfile;

export const networkProfiles = [
  directNetworkProfile,
  relayNetworkProfile,
  relayLossyNetworkProfile,
] as const;
