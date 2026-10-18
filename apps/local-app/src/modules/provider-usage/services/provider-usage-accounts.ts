import { createHash } from 'crypto';
import { homedir } from 'os';
import { basename, join, resolve } from 'path';
import { PROVIDER_USAGE_PROVIDERS } from '@devchain/shared';
import type { ProviderUsageAccount } from '../provider-usage.types';

/** Any of these makes Claude bill an API or a cloud account, which has no subscription usage. */
const CLAUDE_NON_SUBSCRIPTION_ENV = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

const CODEX_IDENTITY_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'] as const;

/** Same order as a launch: process env, then the project-scoped provider env, then the config env. */
export function buildEffectiveEnv(
  processEnv: NodeJS.ProcessEnv,
  providerEnv: Record<string, string> | null,
  configEnv: Record<string, string> | null,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...(providerEnv ?? {}), ...(configEnv ?? {}) };
}

/** Null when the provider has no subscription usage for this env. */
export function resolveUsageAccount(
  providerName: string,
  env: Readonly<Record<string, string>>,
): ProviderUsageAccount | null {
  const home = homeDir(env);
  switch (providerName.toLowerCase()) {
    case 'claude': {
      if (CLAUDE_NON_SUBSCRIPTION_ENV.some((key) => valueOf(env, key) !== null)) return null;
      const token = valueOf(env, 'CLAUDE_CODE_OAUTH_TOKEN');
      if (token !== null) {
        const id = sha256Prefix(token);
        return {
          key: `claude:token:${id}`,
          provider: 'claude',
          kind: 'claude-token',
          label: `Claude token ${id.slice(0, 6)}`,
        };
      }
      const configDir = claudeConfigDir(env);
      return {
        key: `claude:login:${configDir}`,
        provider: 'claude',
        kind: 'claude-login',
        label:
          valueOf(env, 'CLAUDE_CONFIG_DIR') !== null ? `Claude (${basename(configDir)})` : 'Claude',
      };
    }
    case 'codex': {
      const customHome = valueOf(env, 'CODEX_HOME');
      const codexHome = customHome !== null ? resolve(customHome) : join(home, '.codex');
      const identity = CODEX_IDENTITY_ENV.flatMap((key) => {
        const value = valueOf(env, key);
        return value !== null ? [`${key}=${value}`] : [];
      }).join('\n');
      const id = identity ? sha256Prefix(identity) : 'none';
      const suffixes = [
        customHome !== null ? basename(codexHome) : null,
        identity ? `key ${id.slice(0, 6)}` : null,
      ].filter((part): part is string => part !== null);
      return {
        key: `codex:${codexHome}:${id}`,
        provider: 'codex',
        kind: 'codex',
        label: suffixes.length > 0 ? `Codex (${suffixes.join(', ')})` : 'Codex',
      };
    }
    case 'agy':
      return { key: `agy:${home}`, provider: 'agy', kind: 'agy', label: 'agy' };
    default:
      return null;
  }
}

/** The Claude Code config directory that this env selects. */
export function claudeConfigDir(env: Readonly<Record<string, string>>): string {
  const customDir = valueOf(env, 'CLAUDE_CONFIG_DIR');
  return customDir !== null ? resolve(customDir) : join(homeDir(env), '.claude');
}

export function compareUsageAccounts(a: ProviderUsageAccount, b: ProviderUsageAccount): number {
  return (
    PROVIDER_USAGE_PROVIDERS.indexOf(a.provider) - PROVIDER_USAGE_PROVIDERS.indexOf(b.provider)
  );
}

function homeDir(env: Readonly<Record<string, string>>): string {
  return valueOf(env, 'HOME') ?? homedir();
}

function valueOf(env: Readonly<Record<string, string>>, key: string): string | null {
  const value = env[key];
  return value === undefined || value === '' ? null : value;
}

function sha256Prefix(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
