import { z } from 'zod';
import type { ProviderAuthEntry } from '../storage/models/domain.models';
import {
  PROVIDER_AUTH_ENV_KEY_PATTERN,
  RESERVED_PROVIDER_AUTH_ENV_KEYS,
} from './provider-auth-adapters';

/** Vault metadata as the routes return it: no ciphertext, no payload. */
export type ProviderAuthEntryDto = Omit<ProviderAuthEntry, 'payloadCiphertext'>;

const ENV_KEY_MESSAGE = 'envKey must be an upper-case style environment variable name';

export const ProviderAuthEnvKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(PROVIDER_AUTH_ENV_KEY_PATTERN, ENV_KEY_MESSAGE)
  .refine((key) => !RESERVED_PROVIDER_AUTH_ENV_KEYS.has(key), {
    message: 'This environment key is reserved and cannot be stored.',
  });

/** Env values stay single-line and inside the claim endpoint's size bound. */
export const ProviderAuthEnvValueSchema = z
  .string()
  .min(1)
  .max(16 * 1024)
  .refine((value) => !/[\0\r\n]/.test(value), {
    message: 'The value must be a single line without control characters.',
  });

export const PROVIDER_AUTH_LABEL_MAX_LENGTH = 128;

const LabelSchema = z.string().trim().min(1).max(PROVIDER_AUTH_LABEL_MAX_LENGTH);

const ProviderSchema = z.string().trim().min(1).max(32);

/** Paste a token: either `{ provider, label, token }` (fixed env key) or the generic `{ envKey, value }` form. */
export const CreateProviderAuthStaticSchema = z.union([
  z
    .object({ provider: ProviderSchema, label: LabelSchema, token: ProviderAuthEnvValueSchema })
    .strict(),
  z
    .object({
      provider: ProviderSchema,
      label: LabelSchema,
      envKey: ProviderAuthEnvKeySchema,
      value: ProviderAuthEnvValueSchema,
    })
    .strict(),
]);

export type CreateProviderAuthStaticData = z.infer<typeof CreateProviderAuthStaticSchema>;

const OPENCODE_PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/i;

/** File keys must match exactly; only the import request schema trims user input. */
export function isOpencodeProviderId(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && OPENCODE_PROVIDER_ID.test(value);
}

const OpencodeProviderIdSchema = z.string().trim().refine(isOpencodeProviderId, {
  message: 'providerId must be 1-128 letters, digits or dashes.',
});

export const ImportOpencodeSchema = z
  .object({
    providerIds: z.array(OpencodeProviderIdSchema).min(1),
  })
  .strict();

export type ImportOpencodeData = z.infer<typeof ImportOpencodeSchema>;

/** One row of the opencode-logins list: an id and a fixed type, never a credential value. */
export interface OpencodeLoginDto {
  providerId: string;
  type: 'api' | 'wellknown' | 'oauth' | 'other';
  importable: boolean;
  imported: boolean;
}

export const ProviderAuthEntryIdSchema = z.string().uuid();

export const CheckoutSchema = z
  .object({
    remoteId: z.string().uuid(),
  })
  .strict();

export const RenameProviderAuthSchema = z.object({ label: LabelSchema }).strict();

export type PerProviderIdImportResult =
  | { providerId: string; outcome: 'imported'; entryId: string }
  | { providerId: string; outcome: 'refused'; reason: string }
  | { providerId: string; outcome: 'missing' };

export const GenerateProviderAuthSchema = z
  .object({ provider: ProviderSchema, label: LabelSchema.optional() })
  .strict();

export const ProviderAuthGenerationIdSchema = z.string().uuid();
