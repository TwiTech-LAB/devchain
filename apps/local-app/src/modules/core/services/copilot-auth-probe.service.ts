import { Injectable } from '@nestjs/common';
import { homedir } from 'os';
import { join } from 'path';
import { readFile } from 'fs/promises';

/**
 * Actionable remediation shown when the Copilot auth probe finds no sign of a
 * logged-in user. Kept as a single source of truth (S1-captured string).
 */
export const COPILOT_AUTH_REMEDIATION =
  'GitHub Copilot CLI is not authenticated. Run `copilot login` to sign in ' +
  '(or set COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN).';

/** Auth token env vars, in copilot's documented precedence order. */
const AUTH_TOKEN_ENV_KEYS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;

/**
 * Best-effort, NON-BLOCKING auth-state probe for the GitHub Copilot CLI.
 *
 * Per spike S1 (epic 3be9ec57): there is NO `copilot login --status`/whoami
 * command, and the authoritative credential lives in the OS keyring (or env, or
 * a plaintext fallback) — none cheaply/reliably inspectable. So this is a HINT
 * only: `loggedInUsers[]` has confirmed false-negatives (keyring/env logins) and
 * false-positives (stale token). Consumers must surface a WARNING, never hard-block
 * launch — the real auth error surfaces at launch time.
 *
 * Authenticated-hint is true when EITHER:
 *  - one of `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` is set, OR
 *  - `~/.copilot/config.json` `loggedInUsers[]` is a non-empty array.
 *
 * The config is JSONC (a leading `//` comment header); we strip only leading
 * comment lines before parsing (never a `"host":"https://…"` value) and tolerate
 * any read/parse failure by treating it as "no signal" (the env check still applies).
 */
@Injectable()
export class CopilotAuthProbeService {
  private get configPath(): string {
    return join(homedir(), '.copilot', 'config.json');
  }

  async isAuthenticated(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    if (AUTH_TOKEN_ENV_KEYS.some((key) => (env[key] ?? '').trim().length > 0)) {
      return true;
    }
    return this.hasLoggedInUsers();
  }

  private async hasLoggedInUsers(): Promise<boolean> {
    let raw: string;
    try {
      raw = await readFile(this.configPath, 'utf-8');
    } catch {
      return false;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(this.stripJsoncHeader(raw));
    } catch {
      return false;
    }

    const users = (parsed as { loggedInUsers?: unknown })?.loggedInUsers;
    return Array.isArray(users) && users.length > 0;
  }

  /** Drop leading `//`/blank lines (the JSONC header) before the JSON body. */
  private stripJsoncHeader(raw: string): string {
    const lines = raw.split('\n');
    let i = 0;
    while (i < lines.length) {
      const trimmed = lines[i].trim();
      if (trimmed === '' || trimmed.startsWith('//')) {
        i++;
        continue;
      }
      break;
    }
    return lines.slice(i).join('\n');
  }
}
