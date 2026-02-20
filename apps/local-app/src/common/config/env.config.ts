import { z } from 'zod';
import * as dotenv from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

dotenv.config();

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.string().regex(/^\d+$/).transform(Number).default('3000'),
    HOST: z.string().default('127.0.0.1'),
    LOG_LEVEL: z
      .enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
    DEVCHAIN_MODE: z.enum(['normal', 'main']).default('normal'),
    DATABASE_URL: z.string().optional(),
    REPO_ROOT: z.string().optional(),
    WORKTREES_ROOT: z.string().optional(),
    WORKTREES_DATA_ROOT: z.string().optional(),
    CONTAINER_PROJECT_ID: z.string().uuid().optional(),
    RUNTIME_TOKEN: z.string().optional(),
    RUNTIME_PORT_FILE: z.string().optional(),
    TEMPLATES_DIR: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    const requiresOrchestratorEnv = env.DEVCHAIN_MODE === 'main';

    if (requiresOrchestratorEnv && (!env.REPO_ROOT || !env.REPO_ROOT.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REPO_ROOT'],
        message: 'REPO_ROOT is required when DEVCHAIN_MODE is main',
      });
      return;
    }

    if (requiresOrchestratorEnv && env.REPO_ROOT) {
      const resolvedRepoRoot = resolve(env.REPO_ROOT);
      if (!existsSync(resolvedRepoRoot)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['REPO_ROOT'],
          message: `REPO_ROOT path does not exist: ${resolvedRepoRoot}`,
        });
      }
    }
  })
  .transform((env) => {
    if (env.DEVCHAIN_MODE !== 'main' || !env.REPO_ROOT) {
      return env;
    }

    const repoRoot = resolve(env.REPO_ROOT);
    return {
      ...env,
      REPO_ROOT: repoRoot,
      WORKTREES_ROOT: env.WORKTREES_ROOT
        ? resolve(env.WORKTREES_ROOT)
        : resolve(repoRoot, '.devchain', 'worktrees'),
      WORKTREES_DATA_ROOT: env.WORKTREES_DATA_ROOT
        ? resolve(env.WORKTREES_DATA_ROOT)
        : resolve(repoRoot, '.devchain', 'worktrees-data'),
    };
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
