export { DEVICE_CRYPTO_UNAVAILABLE_NOTICE, checkDeviceCryptoSupport } from "./capabilities.js";

export {
  DeviceStorageError,
  deleteDeviceIdentity,
  deletePeerTrustState,
  loadDeviceIdentity,
  loadPeerTrustStates,
  saveDeviceIdentity,
  savePeerTrustState,
  withDeviceLock,
  type DeviceStorageErrorCode,
  type StoredDeviceIdentity,
} from "./identity-store.js";

export {
  DEVICE_REPLACEMENT_WARNING,
  ensureDeviceEnrollment,
  linkDeviceBackup,
  loadCurrentDevice,
  resetDeviceEncryption,
  revokeCurrentDevice,
  type DeviceEnrollmentOptions,
  type EnsureDeviceResult,
  type ResetDeviceOptions,
  type ResetDeviceResult,
  type RevokeDeviceOptions,
  type RevokeDeviceResult,
} from "./enrollment.js";
