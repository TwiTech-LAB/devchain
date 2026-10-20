import { Injectable } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { applyProviderCliNoUpdate } from '../../providers/adapters/provider-cli-policy';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import type {
  ProviderUsageAccount,
  ProviderUsageChecker,
  ProviderUsageCheckResult,
} from '../provider-usage.types';
import { claudeConfigDir } from '../services/provider-usage-accounts';
import { parseClaudeUsageStream } from './claude-usage-parser';
import { ensureUsageCheckCwd } from './private-cwd';

export const CLAUDE_USAGE_TIMEOUT_MS = 20_000;
/** The stream-json init event lists every tool, skill, plugin and MCP server first. */
export const CLAUDE_USAGE_MAX_OUTPUT_BYTES = 1024 * 1024;

const NOT_LOGGED_IN_RE = /not logged in|please run \/login/i;
const PLAN_FIELD_RE = /^[A-Za-z0-9_]{1,40}$/;

/**
 * Reads a stored Claude login through `claude -p /usage` with stream-json output, which
 * carries a structured usage report next to the text. The process runs in an empty
 * directory of its own: a project directory would load that project's hooks, `CLAUDE.md`
 * and MCP servers into the check.
 */
@Injectable()
export class ClaudeLoginChecker implements ProviderUsageChecker {
  readonly kind = 'claude-login' as const;

  constructor(private readonly executor: ProcessExecutor) {}

  async check(
    _account: ProviderUsageAccount,
    env: Readonly<Record<string, string>>,
    binPath: string,
  ): Promise<ProviderUsageCheckResult> {
    const cwd = await ensureUsageCheckCwd('claude-cwd');

    // `--bare` would disable OAuth, and `/usage` then has no plan data.
    const command = applyProviderCliNoUpdate(
      'claude',
      [
        binPath,
        '-p',
        '/usage',
        '--no-session-persistence',
        // `--print` accepts stream-json only with `--verbose`.
        '--output-format',
        'stream-json',
        '--verbose',
      ],
      withoutParentSessionEnv(env),
    );
    const result = await this.executor.run({
      argv: command.argv,
      mode: 'pipe',
      cwd,
      env: command.env,
      timeout: CLAUDE_USAGE_TIMEOUT_MS,
      outputLimits: { maxBytes: CLAUDE_USAGE_MAX_OUTPUT_BYTES },
    });

    if (result.timedOut) throw new Error('claude /usage timed out');

    const parsed = parseClaudeUsageStream(result.stdout, Date.now());
    if (parsed.kind === 'ok') {
      return {
        kind: 'ok',
        windows: parsed.windows,
        extras: parsed.extras,
        plan: await readPlanLabel(claudeConfigDir(env)),
        source: 'cli',
      };
    }
    if (parsed.kind === 'not-available') {
      return { kind: 'not-available', error: 'Not a subscription login' };
    }
    if (NOT_LOGGED_IN_RE.test(result.stdout) || NOT_LOGGED_IN_RE.test(result.stderr)) {
      return { kind: 'not-available', error: 'Not logged in' };
    }
    if (!result.success) throw new Error(`claude /usage failed (exit ${result.exitCode})`);
    throw new Error('usage format not recognized');
  }
}

/** A parent Claude session leaks `CLAUDECODE` and `CLAUDE_CODE_*`; they change what the child loads. */
function withoutParentSessionEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => key !== 'CLAUDECODE' && !key.startsWith('CLAUDE_CODE_')),
  );
}

/**
 * Only the two plan fields leave the credentials file; its tokens are never copied out
 * or logged. Null when the file is absent (e.g. the login lives in a keychain) or unreadable.
 */
async function readPlanLabel(configDir: string): Promise<string | null> {
  try {
    const credentials: unknown = JSON.parse(
      await readFile(join(configDir, '.credentials.json'), 'utf8'),
    );
    const oauth = (credentials as { claudeAiOauth?: Record<string, unknown> } | null)
      ?.claudeAiOauth;
    const type = planField(oauth?.subscriptionType);
    if (!type) return null;
    const multiplier = /_(\d+x)$/i.exec(planField(oauth?.rateLimitTier) ?? '')?.[1];
    const name = type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
    return multiplier ? `${name} ${multiplier.toLowerCase()}` : name;
  } catch {
    return null;
  }
}

function planField(value: unknown): string | null {
  return typeof value === 'string' && PLAN_FIELD_RE.test(value) ? value : null;
}
