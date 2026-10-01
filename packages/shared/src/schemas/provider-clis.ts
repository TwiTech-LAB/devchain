import { z } from 'zod';

/**
 * Provider CLIs DevChain can version-manage. The package names mirror
 * `scripts/host-cli-pins.json`; a provider missing here (e.g. agy) has no npm
 * package and is out of version management entirely.
 */
export const PROVIDER_CLI_NAMES = ['claude', 'codex', 'copilot', 'opencode'] as const;

export type ProviderCliName = (typeof PROVIDER_CLI_NAMES)[number];

export const PROVIDER_CLI_NPM_PACKAGES: Readonly<Record<ProviderCliName, string>> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  copilot: '@github/copilot',
  opencode: 'opencode-ai',
};

/**
 * Provider CLI releases come from the public npm registry on every machine,
 * home and VM alike; never from `HOST_NPM_REGISTRY` or a DevChain image
 * registry.
 */
export const NPM_PUBLIC_REGISTRY_URL = 'https://registry.npmjs.org/';

/** Exact `x.y.z` stable release: no prerelease, no build metadata, no leading zeros. */
const EXACT_STABLE_SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isExactStableSemver(version: string): boolean {
  return EXACT_STABLE_SEMVER_REGEX.test(version);
}

export const ProviderCliNameSchema = z.enum(PROVIDER_CLI_NAMES);

/** `latest` or an exact stable `x.y.z` pin; preview releases are not pinnable. */
export const ProviderCliVersionChoiceSchema = z.union([
  z.literal('latest'),
  z
    .string()
    .regex(EXACT_STABLE_SEMVER_REGEX, 'Version must be "latest" or an exact x.y.z stable release'),
]);

export type ProviderCliVersionChoice = z.infer<typeof ProviderCliVersionChoiceSchema>;

export const ProviderCliVersionEntrySchema = z
  .object({
    version: ProviderCliVersionChoiceSchema,
    homeManaged: z.boolean(),
  })
  .strict();

export type ProviderCliVersionEntry = z.infer<typeof ProviderCliVersionEntrySchema>;

/**
 * The persisted `providers.cliVersions` map: one entry per allowlisted provider.
 * The explicit type (not `z.infer`) keeps the keys a finite union so reads are
 * never `undefined` under `noUncheckedIndexedAccess`.
 */
export const ProviderCliVersionSettingsMapSchema = z.record(
  ProviderCliNameSchema,
  ProviderCliVersionEntrySchema,
);

export type ProviderCliVersionSettingsMap = Record<ProviderCliName, ProviderCliVersionEntry>;

/** Machine-local managed-install state; reported but never synced between machines. */
export const ProviderCliInstallStatusSchema = z
  .object({
    desiredVersion: ProviderCliVersionChoiceSchema,
    installedVersion: z.string().nullable(),
    state: z.enum(['idle', 'installing', 'failed']),
    error: z.string().nullable(),
    checkedAt: z.string().nullable(),
  })
  .strict();

export type ProviderCliInstallStatus = z.infer<typeof ProviderCliInstallStatusSchema>;

export interface ProviderCliLookupResult {
  /** Newest release according to the registry's `latest` dist-tag; null until a check succeeds. */
  latestVersion: string | null;
  /** Newest stable releases for the pin list; empty until a check succeeds. */
  versions: string[];
  /** ISO timestamp of the last completed check, successful or not. */
  checkedAt: string | null;
  /** Error of the last check; a failed check keeps the last successful versions above. */
  error: string | null;
}

export interface ProviderCliStatus {
  provider: ProviderCliName;
  npmPackage: string;
  setting: ProviderCliVersionEntry;
  lookup: ProviderCliLookupResult | null;
  install: ProviderCliInstallStatus | null;
}

export interface ProviderClisOverview {
  providers: Record<ProviderCliName, ProviderCliStatus>;
}
