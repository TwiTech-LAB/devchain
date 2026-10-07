import { z } from 'zod';
import * as dotenv from 'dotenv';

dotenv.config();

const TRUE_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);

/** A flag that is on unless set to a value other than 1, true, yes or on. */
const onByDefaultFlagSchema = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string' || value.trim() === '') return true; // unset/empty → on
  return TRUE_ENV_VALUES.has(value.trim().toLowerCase()); // explicit → truthy check
}, z.boolean());

/** An unset or blank value is absent. */
const optionalPathSchema = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().regex(/^\d+$/).transform(Number).default('3000'),
  HOST: z
    .string()
    .default('127.0.0.1')
    .transform((v) => v.trim())
    .refine((v) => v.length > 0, { message: 'HOST must not be empty' })
    .refine((v) => v !== '*', { message: 'HOST must not be "*"' })
    .refine((v) => !/[\x00-\x1f\x7f]/.test(v), {
      message: 'HOST must not contain control characters',
    }),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().optional(),
  RUNTIME_TOKEN: z.string().optional(),
  RUNTIME_PORT_FILE: z.string().optional(),
  HOST_IMAGE_URL: z.string().url().optional(),
  HOST_IMAGE_SHA256: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/)
    .optional(),
  HOST_NPM_REGISTRY: z.string().url().optional(),
  DEVCHAIN_CLOUD_UI_ENABLED: onByDefaultFlagSchema,
  TEMPLATES_DIR: z.string().optional(),
  REMOTES_HEALTH_INTERVAL_MS: z.string().regex(/^\d+$/).transform(Number).default('10000'),
  REMOTES_SYNC_INTERVAL_MS: z.string().regex(/^\d+$/).transform(Number).default('5000'),
  REMOTES_RECONCILE_INTERVAL_MS: z.string().regex(/^\d+$/).transform(Number).default('120000'),
  REMOTES_TIME_SETTLE_TIMEOUT_MS: z.string().regex(/^\d+$/).transform(Number).default('30000'),
  SYNCTHING_BIN: z.string().optional(),
  // Scheduled provider CLI registry checks (at start and every 6 hours).
  PROVIDER_CLI_CHECKS_ENABLED: onByDefaultFlagSchema,
  SKILLS_STARTUP_SYNC_ENABLED: onByDefaultFlagSchema,
  // Claim record and root helpers of a host VM (apps/host-bootstrap).
  DEVCHAIN_HOST_ETC_DIR: z.string().default('/etc/devchain-host'),
  DEVCHAIN_HOST_BIN_DIR: z.string().default('/usr/local/bin'),
  // The VM certificate for the app port, set by the host unit (apps/host-bootstrap).
  DEVCHAIN_HOST_TLS_KEY_FILE: optionalPathSchema,
  DEVCHAIN_HOST_TLS_CERT_FILE: optionalPathSchema,
});

export type EnvConfig = z.infer<typeof envSchema>;

let cachedConfig: EnvConfig | null = null;

export function getEnvConfig(): EnvConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment configuration:', result.error.format());
    throw new Error('Environment validation failed');
  }

  cachedConfig = result.data;
  return cachedConfig;
}

export function resetEnvConfig(): void {
  cachedConfig = null;
}
