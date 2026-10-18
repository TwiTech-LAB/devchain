import { z } from 'zod';

export const PROVIDER_USAGE_PROVIDERS = ['claude', 'codex', 'agy'] as const;
export type ProviderUsageProvider = (typeof PROVIDER_USAGE_PROVIDERS)[number];

export const UsageWindowSchema = z
  .object({
    id: z.string().min(1),
    label: z.string(),
    kind: z.enum(['5h', 'weekly', 'other']),
    /** Can exceed 100 when a provider reports overage. */
    usedPercent: z.number().min(0),
    /** Epoch seconds. */
    resetsAt: z.number().nullable(),
  })
  .strict();
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

/** Labels of the two windows that several providers report. */
export const STANDARD_WINDOW_LABELS = {
  '5h': '5-hour limit',
  weekly: 'Weekly limit',
} as const;

export const UsageSnapshotStateSchema = z.enum([
  'ok',
  'stale',
  'error',
  'unsupported',
  'not-available',
]);
export type UsageSnapshotState = z.infer<typeof UsageSnapshotStateSchema>;

export const UsageSnapshotSchema = z
  .object({
    accountKey: z.string().min(1),
    provider: z.enum(PROVIDER_USAGE_PROVIDERS),
    label: z.string(),
    windows: z.array(UsageWindowSchema),
    /** Claude per-model weekly windows and agy model groups. */
    extras: z.array(UsageWindowSchema),
    plan: z.string().nullable(),
    /** Null until the account has reported data once. */
    source: z.enum(['cli', 'headers']).nullable(),
    /** When the windows were read; null until the account has reported data once. */
    fetchedAt: z.string().nullable(),
    /**
     * `stale`: no data yet, or the data is older than `openProjectMaxAgeMin`.
     * `error`: the last check failed; the windows are the last good data.
     */
    state: UsageSnapshotStateSchema,
    error: z.string().nullable(),
  })
  .strict();
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;

export const PROVIDER_USAGE_SETTINGS_DEFAULTS = {
  enabled: true,
  runningMaxAgeMin: 5,
  openProjectMaxAgeMin: 30,
  hoverMaxAgeSec: 60,
  tokenCheckMinutes: 10,
} as const;

/** Bounds of the interval settings, shared by the schema, the API and the settings card. */
export const PROVIDER_USAGE_INTERVAL_LIMITS = {
  runningMaxAgeMin: { min: 1, max: 60 },
  openProjectMaxAgeMin: { min: 5, max: 240 },
  hoverMaxAgeSec: { min: 15, max: 600 },
  /** Besides 0, which turns the check off. */
  tokenCheckMinutes: { min: 5, max: 60 },
} as const;

function intervalSchema({ min, max }: { min: number; max: number }) {
  return z.number().int().min(min).max(max);
}

export const ProviderUsageSettingsSchema = z
  .object({
    enabled: z.boolean(),
    runningMaxAgeMin: intervalSchema(PROVIDER_USAGE_INTERVAL_LIMITS.runningMaxAgeMin),
    openProjectMaxAgeMin: intervalSchema(PROVIDER_USAGE_INTERVAL_LIMITS.openProjectMaxAgeMin),
    hoverMaxAgeSec: intervalSchema(PROVIDER_USAGE_INTERVAL_LIMITS.hoverMaxAgeSec),
    /** 0 turns the token header check off. */
    tokenCheckMinutes: z.union([
      z.literal(0),
      intervalSchema(PROVIDER_USAGE_INTERVAL_LIMITS.tokenCheckMinutes),
    ]),
  })
  .strict();
export type ProviderUsageSettings = z.infer<typeof ProviderUsageSettingsSchema>;

export const ProviderUsageResponseSchema = z
  .object({
    accounts: z.array(UsageSnapshotSchema),
    config: ProviderUsageSettingsSchema,
  })
  .strict();
export type ProviderUsageResponse = z.infer<typeof ProviderUsageResponseSchema>;
