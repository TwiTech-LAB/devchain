import type { ProviderUsageProvider, UsageWindow } from '@devchain/shared';

export type ProviderUsageCheckerKind = 'claude-login' | 'claude-token' | 'codex' | 'agy';

export interface ProviderUsageAccount {
  key: string;
  provider: ProviderUsageProvider;
  kind: ProviderUsageCheckerKind;
  label: string;
}

export type ProviderUsageCheckResult =
  | {
      kind: 'ok';
      windows: UsageWindow[];
      extras: UsageWindow[];
      plan: string | null;
      source: 'cli' | 'headers';
    }
  /** The account reports no usage, e.g. not logged in. */
  | { kind: 'not-available'; error: string }
  /** The installed CLI cannot report usage safely, e.g. a version that bills `/usage` as a prompt. */
  | { kind: 'unsupported'; error: string };

/**
 * Reads the usage of one account. A thrown error marks the snapshot `error` and keeps
 * the last good windows. Error messages reach the API after env values are redacted.
 */
export interface ProviderUsageChecker {
  readonly kind: ProviderUsageCheckerKind;
  check(
    account: ProviderUsageAccount,
    env: Readonly<Record<string, string>>,
    binPath: string,
  ): Promise<ProviderUsageCheckResult>;
}

export const PROVIDER_USAGE_CHECKERS = Symbol('PROVIDER_USAGE_CHECKERS');
