/**
 * Account-settings module public surface (account-settings, tasks 7.2–7.6).
 *
 * Per-account console preferences (read/update) + the Codex EXECUTION credential
 * (a concept distinct from console login): two mutually-exclusive provider modes,
 * the compatible-provider API key encrypted at rest with AES-256-GCM (never
 * returned in plaintext), and candidate model discovery without first persisting.
 */
export { SettingsModule } from './settings.module';
export { SettingsService, CODEX_CRED_ENC_KEY_ENV } from './settings.service';
export {
  ModelDiscoveryClient,
  classifyModelDiscoveryOutcome,
  extractModelIds,
  modelsEndpoint,
  type ModelDiscoveryResult,
  type ModelDiscoveryErrorCode,
} from './model-discovery.client';
export {
  resolveAccountSettings,
  validateDefaultRepoSelection,
  applySettingsUpdate,
  projectCredentialRead,
  projectCredentialSave,
  deriveCredentialState,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_WRITE_CONFIRM,
  type StoredAccountPrefs,
  type StoredCredentialFacts,
  type NextCredentialPlan,
  type CredentialKeyAction,
  type DefaultRepoValidation,
} from './settings-logic';
export {
  encryptSecret,
  decryptSecret,
  resolveEncryptionKey,
  maskApiKeySuffix,
  EncryptionKeyUnavailableError,
  DecryptionFailedError,
  type EncryptedSecret,
} from './settings-crypto';
export {
  assertSafeProviderUrl,
  isUnsafeAddress,
  UnsafeProviderUrlError,
  type UnsafeProviderUrlCode,
  type HostResolver,
} from './assert-safe-provider-url';
