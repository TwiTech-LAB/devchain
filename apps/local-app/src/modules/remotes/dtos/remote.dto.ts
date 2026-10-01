import type { ProviderCliRuntimeReport } from '@devchain/shared';
import type { DockerRuntime } from '../../core/controllers/docker-runtime';
import { z } from 'zod';
import type {
  Remote,
  RemoteOperationKind,
  RemoteOperationState,
} from '../../storage/models/domain.models';
import type { HostStats } from '../../core/models/host-stats.model';
import type { HostEnvOverrideEntry } from '../host/host-env-override-report';

export const BASE_URL_MESSAGE = 'baseUrl must be https://host[:port] with no path';

/**
 * Normalises a remote address to its origin (`https://host[:port]`), or returns
 * null when it is not one: another scheme (a VM is reached over HTTPS only),
 * credentials, a path, query or fragment, or a port the URL parser rejects
 * (> 65535). IPv6 literals such as `https://[::1]:4000` are accepted. Shared
 * with the Cloud page form.
 */
export function normalizeRemoteBaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.pathname !== '/' || url.search || url.hash) return null;
  return url.origin;
}

/** The longest VM name, after trimming. */
export const REMOTE_NAME_MAX_LENGTH = 128;

// Same rule as HOST_API_KEY_PATTERN in ../host-api-key. The UI bundle imports this file,
// so it must not import that module and its node:crypto dependency.
export const RemoteApiKeySchema = z
  .string()
  .regex(/^dck_[A-Za-z0-9_-]{43}$/, 'Enter a valid VM API key.');

export const CERTIFICATE_FINGERPRINT_MESSAGE =
  'Enter the SHA-256 fingerprint of the VM certificate: 64 hex characters, with or without colons.';

/**
 * A SHA-256 certificate fingerprint as the user pastes it: hex with or without
 * colons, in either case, optionally after the `sha256 Fingerprint=` label that
 * `openssl x509 -fingerprint -sha256` prints or the `Certificate fingerprint
 * (SHA-256):` label that the install block prints. Returns 64 upper-case hex
 * characters, the form of `certificateFingerprint`, or null for anything else.
 */
export function parseCertificateFingerprint(value: string): string | null {
  const hex = value
    .trim()
    .replace(/^(?:sha-?256\s+fingerprint\s*=|certificate\s+fingerprint\s*\(sha-?256\)\s*:)\s*/i, '')
    .replace(/:/g, '')
    .toUpperCase();
  return /^[0-9A-F]{64}$/.test(hex) ? hex : null;
}

export const CertificateFingerprintSchema = z
  .string()
  .max(256)
  .transform((value, ctx) => {
    const fingerprint = parseCertificateFingerprint(value);
    if (fingerprint === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: CERTIFICATE_FINGERPRINT_MESSAGE });
      return z.NEVER;
    }
    return fingerprint;
  });

export const CreateRemoteSchema = z
  .object({
    name: z.string().trim().min(1).max(REMOTE_NAME_MAX_LENGTH),
    baseUrl: z.string().transform((value, ctx) => {
      const origin = normalizeRemoteBaseUrl(value);
      if (origin === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: BASE_URL_MESSAGE });
        return z.NEVER;
      }
      return origin;
    }),
    // Only 'address' can be created through this endpoint in this phase.
    kind: z.literal('address').optional().default('address'),
    apiKey: RemoteApiKeySchema.optional(),
    /** Read on the VM itself; the certificate the address shows must match it. */
    certificateFingerprint: CertificateFingerprintSchema,
  })
  .strict();

export type CreateRemoteData = z.infer<typeof CreateRemoteSchema>;

export const UpdateRemoteNameSchema = z
  .object({
    name: z.string().trim().min(1).max(REMOTE_NAME_MAX_LENGTH),
  })
  .strict();

export type UpdateRemoteNameData = z.infer<typeof UpdateRemoteNameSchema>;

/** A stored remote enriched with its last-known `RemoteHealthService` poll state. */
export interface RemoteListItemDto extends Remote {
  cliVersions?: Record<string, string> | null;
  providerClis?: ProviderCliRuntimeReport | null;
  docker?: DockerRuntime;
  online: boolean;
  apiKeyRejected?: boolean;
  version: string | null;
  versionMatches: boolean;
  /** The remote process's real account ids, when its runtime reports them. */
  uid: number | null;
  gid: number | null;
  /**
   * Keys stored on the remote that shadow its applied `host.env` logins,
   * names only; null when the remote's runtime reports none.
   */
  providerEnvOverrides?: HostEnvOverrideEntry[] | null;
  stats: HostStats | null;
  lastSeenAt: string | null;
  powerState?: 'running' | 'stopped' | 'unknown';
  /** The home folder that the VM's DevChain reports; null when it reported none. */
  homePath: string | null;
  /** null when the VM did not report a home folder. */
  homePathMatches: boolean | null;
  /** The newest operation of this VM, any kind or state. Only a terminal marker for the UI. */
  lastOperation: RemoteLastOperationDto | null;
  /**
   * The OS user the VM was provisioned for, from the same claim-kind record
   * as `logins`; null when this PC never set the VM up or the record
   * predates the field.
   */
  userName: string | null;
  /**
   * The logins of the newest done operation whose kind is in CLAIM_IDENTITY_KINDS,
   * per provider; null when this PC never set the VM up. Never credentials.
   */
  logins: RemoteLoginsDto | null;
}

export interface RemoteLastOperationDto {
  id: string;
  kind: RemoteOperationKind;
  state: RemoteOperationState;
  updatedAt: string;
}

export type RemoteLoginsDto = Record<
  string,
  { choice: 'reuse' | 'generate' | 'skip'; entryIds: string[] }
>;

/** In-memory stats trend for one remote; `intervalMs` is the health poll cadence. */
export interface RemoteStatsHistoryDto {
  intervalMs: number;
  samples: HostStats[];
}
