import { Injectable } from '@nestjs/common';
import type { UsageWindow } from '@devchain/shared';
import { createLogger } from '../../../common/logging/logger';
import type {
  ProviderUsageAccount,
  ProviderUsageChecker,
  ProviderUsageCheckResult,
} from '../provider-usage.types';
import { standardWindow } from './checker-helpers';

const logger = createLogger('ClaudeTokenChecker');

const CLAUDE_TOKEN_CHECK_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_TOKEN_CHECK_MODEL = 'claude-haiku-4-5';
const CLAUDE_TOKEN_CHECK_TIMEOUT_MS = 20_000;

const HEADER_PREFIX = 'anthropic-ratelimit-unified-';

/**
 * Reads the usage of a `CLAUDE_CODE_OAUTH_TOKEN` account from the rate-limit headers of one
 * minimal `/v1/messages` request; Claude Code itself exposes nothing for these accounts. The
 * request spends tokens, so the caller must only run it for an account with a running session.
 * The token is sent in one header and never logged or put into an error.
 */
@Injectable()
export class ClaudeTokenChecker implements ProviderUsageChecker {
  readonly kind = 'claude-token' as const;

  async check(
    _account: ProviderUsageAccount,
    env: Readonly<Record<string, string>>,
  ): Promise<ProviderUsageCheckResult> {
    const token = env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!token) throw new Error('token missing');

    let response: Response;
    try {
      response = await fetch(CLAUDE_TOKEN_CHECK_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: CLAUDE_TOKEN_CHECK_MODEL,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
        signal: AbortSignal.timeout(CLAUDE_TOKEN_CHECK_TIMEOUT_MS),
      });
    } catch {
      throw new Error('check failed');
    }
    // Only the headers are used; release the connection without reading the body.
    await response.body?.cancel().catch(() => undefined);

    const status = response.status;
    logger.debug({ status }, 'Claude token usage check answered');

    // A rate-limited (429) answer still carries the headers, so they are read before the status.
    const windows = [
      readWindow(response.headers, '5h', '5h'),
      readWindow(response.headers, '7d', 'weekly'),
    ].filter((window): window is UsageWindow => window !== null);
    if (windows.length > 0) {
      return { kind: 'ok', windows, extras: [], plan: null, source: 'headers' };
    }

    if (status === 401 || status === 403) throw new Error(`token rejected (${status})`);
    if (status === 400 || status === 404) throw new Error(`check request rejected (${status})`);
    throw new Error('no usage headers');
  }
}

function readWindow(
  headers: Headers,
  name: '5h' | '7d',
  kind: '5h' | 'weekly',
): UsageWindow | null {
  const utilization = numberHeader(headers, `${HEADER_PREFIX}${name}-utilization`);
  const resetsAt = numberHeader(headers, `${HEADER_PREFIX}${name}-reset`);
  if (utilization === null || utilization < 0 || resetsAt === null) return null;
  return standardWindow(kind, Math.round(utilization * 1000) / 10, resetsAt);
}

function numberHeader(headers: Headers, name: string): number | null {
  const text = headers.get(name)?.trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}
