import { z } from 'zod';
import type { ProviderAuthClaimBundle } from '../../provider-auth/provider-auth-adapters';

/** Logins to take away in the same apply request, before any write runs. */
export interface HostProviderAuthRemoveSpec {
  envKeys: string[];
  files: string[];
}

export type HostProviderApplyInput = ProviderAuthClaimBundle & {
  remove?: HostProviderAuthRemoveSpec;
};

export const HostProviderVerifyRequestSchema = z
  .object({
    provider: z.string().trim().min(1).max(32),
    opencodeProviderIds: z.array(z.string().min(1).max(128)).max(32).optional().default([]),
  })
  .strict();

const RemoveSchema = z
  .object({
    envKeys: z.array(z.string().min(1).max(128)).max(64).default([]),
    files: z.array(z.string().min(1).max(4096)).max(32).default([]),
  })
  .strict();

export const HostProviderApplyRequestSchema = z
  .object({
    env: z.record(z.string(), z.string()).default({}),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            mode: z.literal('0600'),
            contentBase64: z.string().max(400_000),
          })
          .strict(),
      )
      .default([]),
    // Processed before the writes above, so a login that is removed and
    // re-sent in one request ends up present with the new value.
    remove: RemoveSchema.optional(),
  })
  .strict();
