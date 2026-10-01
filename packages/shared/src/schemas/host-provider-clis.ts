import { z } from 'zod';
import {
  PROVIDER_CLI_NAMES,
  PROVIDER_CLI_NPM_PACKAGES,
  ProviderCliInstallStatusSchema,
  ProviderCliVersionChoiceSchema,
  type ProviderCliName,
} from './provider-clis.js';

/** A strict object with one entry per provider CLI, built from `valueFor(provider)`. */
function perProvider<T extends z.ZodTypeAny>(valueFor: (provider: ProviderCliName) => T) {
  const shape = {} as Record<ProviderCliName, T>;
  for (const provider of PROVIDER_CLI_NAMES) shape[provider] = valueFor(provider);
  return z.object(shape).strict();
}

const entry = (packageName: string) =>
  z.object({ package: z.literal(packageName), version: ProviderCliVersionChoiceSchema }).strict();
export const HostProviderCliPolicySchema = perProvider((provider) =>
  entry(PROVIDER_CLI_NPM_PACKAGES[provider]),
);
export type HostProviderCliPolicy = z.infer<typeof HostProviderCliPolicySchema>;

export const HostProviderCliSettingsSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    providers: HostProviderCliPolicySchema,
  })
  .strict();
export type HostProviderCliSettings = z.infer<typeof HostProviderCliSettingsSchema>;

export const ProviderCliRuntimeReportSchema = perProvider(() =>
  ProviderCliInstallStatusSchema.optional(),
);
export type ProviderCliRuntimeReport = z.infer<typeof ProviderCliRuntimeReportSchema>;

const ProviderStatusSchema = z
  .object({
    acceptedVersion: ProviderCliVersionChoiceSchema.nullable(),
    installedVersion: z.string().nullable(),
    state: z.enum(['accepted', 'pending', 'applied', 'failed']),
    error: z.string().nullable(),
  })
  .strict();
export const HostProviderCliSettingsStatusSchema = z
  .object({
    acceptedRevision: z.string().nullable(),
    pendingRevision: z.string().nullable(),
    appliedRevision: z.string().nullable(),
    providers: perProvider(() => ProviderStatusSchema),
  })
  .strict();
export type HostProviderCliSettingsStatus = z.infer<typeof HostProviderCliSettingsStatusSchema>;
