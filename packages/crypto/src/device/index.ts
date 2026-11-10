export {
  CRYPTO_PROVISIONAL_NOTICE,
  CryptoCapabilityError,
  assertCryptoReady,
  detectCryptoCapabilities,
  type CryptoCapability,
  type CryptoCapabilityReport,
  type CryptoEnvironment,
} from "./capabilities.js";

export {
  DEFAULT_ONE_TIME_KEY_COUNT,
  PROVISIONAL_IDENTITY_ALGORITHM,
  assertNoForbiddenFields,
  assertPrivateKeysNonExtractable,
  findForbiddenField,
  generateDeviceIdentity,
  refreshOneTimeKeys,
  toPublicBundle,
  type DeviceFallbackKeyPair,
  type DeviceIdentityMaterial,
  type DeviceOneTimeKeyPair,
  type GenerateDeviceIdentityOptions,
} from "./identity.js";

export { safetyNumberFor, type SafetyNumber, type SafetyNumberParty } from "./safety-number.js";

export {
  MemoryPeerKeyStore,
  PeerKeyGuard,
  acceptPeerKeyChange,
  canSendToPeer,
  markPeerVerified,
  observePeerIdentity,
  type PeerKeyObservation,
  type PeerKeyObservationStatus,
  type PeerKeyState,
  type PeerKeyStore,
} from "./peer-trust.js";

export {
  DeviceApiError,
  DeviceDirectoryVerificationError,
  DeviceEnrollmentClient,
  assertPublishedBundle,
  isDeviceApiError,
  type DeviceApiClientOptions,
} from "./enrollment-client.js";
