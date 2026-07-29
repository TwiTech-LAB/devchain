// Jest-only shim for @devchain/shared.
//
// The real @devchain/shared package is published as ESM, which Jest (CJS) in local-app
// can't import without additional ESM configuration. For tests, we re-export the same
// implementations directly from the workspace TypeScript sources.

export { EnvVarsSchema } from '../../../../packages/shared/src/schemas/env-vars';
export {
  CLAUDE_LAUNCH_SETTINGS_MAX_BYTES,
  DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON,
  validateClaudeLaunchSettingsJson,
  type ClaudeLaunchSettingsValidationResult,
} from '../../../../packages/shared/src/schemas/claude-launch-settings';
export {
  ExportSchema,
  ManifestSchema,
} from '../../../../packages/shared/src/schemas/export-schema';

export {
  parseSemVer,
  isValidSemVer,
  compareSemVer,
  isGreaterThan,
  isLessThan,
  isEqual,
  sortVersions,
  getLatestVersion,
  formatSemVer,
} from '../../../../packages/shared/src/utils/semver';

export { HostResolver } from '../../../../packages/shared/src/host-resolver';

export {
  TUNNEL_PROTOCOL_VERSION_PUSH,
  SUPPORTED_TUNNEL_PROTOCOL_VERSIONS,
  TUNNEL_PUSH_FRAME_TYPE,
  TUNNEL_PUSH_FRAME_VERSION,
  isSupportedTunnelProtocolVersion,
  isPushCapableTunnelProtocolVersion,
  isTunnelPushFrame,
  MOBILE_PUSH_TOPIC_ID_SEGMENT,
  MOBILE_PUSH_TOPIC_ALLOWLIST,
  isAllowlistedTunnelPushTopic,
  TUNNEL_CONTROL_FRAME_TYPE,
  TUNNEL_CONTROL_FRAME_VERSION,
  isTunnelControlFrame,
  isTunnelLivenessQueryFrame,
  isTunnelLivenessResultFrame,
  TUNNEL_VIEWPORT_FRAME_TYPE,
  TUNNEL_VIEWPORT_FRAME_VERSION,
  isTunnelViewportFrame,
  isViewportBody,
  isViewportCursor,
  isMobileViewportSseEvent,
  MOBILE_VIEWPORT_SSE_EVENT,
  MOBILE_VIEWPORT_SSE_PATH_TEMPLATE,
  mobileViewportSsePath,
} from '../../../../packages/shared/src/tunnel-protocol';

export {
  X25519_PRIVATE_KEY_BYTES,
  X25519_PUBLIC_KEY_BYTES,
  E2EE_KID_BYTES,
  deriveKid,
  generateX25519KeyPair,
  fromX25519PrivateKey,
  type E2eeKeyPair,
} from '../../../../packages/shared/src/e2ee/keypair';

export {
  bytesToBase64,
  base64ToBytes,
  InvalidBase64Error,
} from '../../../../packages/shared/src/e2ee/base64';

// Envelope shape + typed errors + the seal/open service (Phase 2 RPC lane). The
// service's ESM-internal `./aad.js` / `./base64.js` / `./envelope.js` specifiers are
// rewritten by the `.js`-strip moduleNameMapper in this app's jest config.
export {
  E2EE_KEY_BYTES,
  E2EE_NONCE_BYTES,
  E2EE_ENVELOPE_VERSION,
  E2EE_ALG_XCHACHA20POLY1305,
  E2eeError,
  E2eeMalformedEnvelopeError,
  E2eeUnsupportedVersionError,
  E2eeUnsupportedAlgError,
  E2eeUnknownKeyError,
  E2eeAuthenticationError,
  E2eeInvalidKeyError,
  isE2eeEnvelope,
  type E2eeEnvelope,
  type E2eeContext,
  type E2eeKeyProvider,
  type SealKey,
  type KeyLookup,
  type RandomBytes,
} from '../../../../packages/shared/src/e2ee/envelope';
export { buildAad } from '../../../../packages/shared/src/e2ee/aad';
export { CryptoEnvelopeService } from '../../../../packages/shared/src/e2ee/crypto-envelope.service';

export {
  E2EE_SHARED_KEY_BYTES,
  E2EE_HKDF_INFO,
  E2EE_HKDF_SALT,
  PAIRING_SECRET_BYTES,
  PAIRING_MAC_BYTES,
  deriveSharedKey,
  buildPairingTranscript,
  computePairingMac,
  verifyPairingMac,
  type PairingTranscriptInput,
} from '../../../../packages/shared/src/e2ee/key-exchange';

export {
  isE2eeVerified,
  reconcilePeerKey,
  markVerifiedViaSafetyNumber,
  type E2eeTrustStatus,
  type E2eeVerificationMethod,
  type E2eeAdoptionMethod,
  type E2eeTrustRecord,
  type IncomingPeerKey,
} from '../../../../packages/shared/src/e2ee/trust';

export {
  E2EE_SAFETY_NUMBER_GROUPS,
  deriveSafetyNumber,
} from '../../../../packages/shared/src/e2ee/safety-number';

export {
  E2EE_NEGOTIATION_VERSION,
  isE2eeCapability,
  isCapable,
  negotiateE2ee,
  buildE2eeCapability,
  type E2eeCapability,
  type E2eeNegotiationMode,
  type E2eeNegotiationReason,
  type E2eeNegotiationResult,
} from '../../../../packages/shared/src/e2ee/negotiation';
