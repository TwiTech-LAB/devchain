import { randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { Injectable } from '@nestjs/common';
import { IOError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { AGY_INLINE_SETTINGS_MIN_VERSION, compareVersions, parseVersion } from './agy-cli-version';
import { getProviderCliNoUpdateOptions } from './provider-cli-policy';
import { ANTIGRAVITY_TRAITS } from './antigravity.traits';
import { stripPromptFlags } from './fork-profile-options';
import type {
  ProviderAdapter,
  AddMcpServerOptions,
  BuildLaunchArgsInput,
  McpServerEntry,
} from './provider-adapter.interface';
import type {
  TranscriptDiscoveryCapability,
  GlobalMcpConfigCapability,
  ProjectProvisioningCapability,
  ProvisioningResult,
  CreateSessionSavePointInput,
  PrepareSessionForkLaunchInput,
  SessionSavePointCopy,
  SessionForkCapability,
  SessionForkLaunchResult,
} from './capabilities';
import { AntigravityTrustedWorkspacesService } from '../../core/services/antigravity-trusted-workspaces.service';

const logger = createLogger('AntigravityAdapter');

/**
 * Adapter for Google Antigravity CLI (`agy`) — a gemini+opencode hybrid with a
 * bubbletea TUI and a per-conversation SQLite store under
 * `~/.gemini/antigravity-cli/`.
 *
 * Provider contract: `docs/provider-standards.md` (Antigravity specifics).
 * - Terminal: inline, so there is no `terminalOutputBehavior`. agy draws on the
 *   main screen unless its `altScreenMode` setting is `"always"`; from
 *   `AGY_INLINE_SETTINGS_MIN_VERSION`, `buildLaunchArgs` forces `"never"` through
 *   `--settings`. Like Claude and Codex, it then gets the scroll-up history refresh
 *   from tmux's clean copy: its redraws clear and reprint the conversation
 *   (`ESC[2J ESC[3J`), and the tmux client does not pass `ESC[3J` on to the web terminal.
 * - Initial prompt is seeded at launch via `initialPromptSeedMode = 'argv'` — agy
 *   is argv-only (spike (g): stdin is rejected with `flag needs an argument`). The
 *   shared launch pipeline (P1-2b) renders the prompt before `resolveLaunchConfig`
 *   and passes it here as `initialPrompt`; we emit it as `--prompt-interactive`
 *   (alias `-i`). NO post-launch paste and NO `launchInitialPromptBehavior`.
 * - Restore is the interactive TUI launch via `--conversation <id>` (conversation
 *   id = providerSessionId). Spike (f): print-mode `-p --conversation` hangs, so
 *   restore must NOT go through print mode — this adapter only produces the TUI
 *   restore argv.
 * - DB-backed discovery, like opencode: `transcriptDiscoveryStrategy = 'all'` and
 *   `providerSessionIdRequiredForRestore = true`.
 *
 * MCP (P2-1): agy has no `agy mcp add` (spike (b)). Its MCP servers live in a
 * single HOME-global JSON file `~/.gemini/config/mcp_config.json` (strace-proven
 * path; project-local `.agents/mcp_config.json` is read-but-ignored upstream) with
 * a gemini/windsurf-style `{ "mcpServers": { "<name>": { "serverUrl": … } } }`
 * shape — `serverUrl` is the required transport field for remote HTTP/SSE. This
 * differs from the opencode-flat `{ "mcp": { … } }` project config, so agy
 * implements `GlobalMcpConfigCapability` and `McpRegistrationPort` routes it to the
 * dedicated `AntigravityMcpRegistrationAdapter` (home-global file IO).
 */
@Injectable()
export class AntigravityAdapter
  implements
    ProviderAdapter,
    TranscriptDiscoveryCapability,
    GlobalMcpConfigCapability,
    ProjectProvisioningCapability,
    SessionForkCapability
{
  readonly providerName = 'agy';
  readonly optionalCliVersion = true as const;
  readonly traits = ANTIGRAVITY_TRAITS;
  readonly launchEnv = getProviderCliNoUpdateOptions(this.providerName).env;

  constructor(private readonly trustedWorkspaces: AntigravityTrustedWorkspacesService) {}

  // Opt-in launch-time seeding (P1-2b). agy is argv-only per spike (g): the prompt
  // is emitted as a `--prompt-interactive <prompt>` argv value, not pasted.
  readonly initialPromptSeedMode = 'argv' as const;

  // TranscriptDiscoveryCapability — agy is DB-backed (per-conversation SQLite):
  // discovery is a structured match and restore needs the conversation id.
  readonly transcriptDiscoveryStrategy = 'all' as const;
  readonly providerSessionIdRequiredForRestore = true;
  readonly forkReadsSavePointTranscript = true;

  buildLaunchArgs({
    mode,
    providerSessionId,
    profileOptionArgs,
    initialPrompt,
    cliVersion,
  }: BuildLaunchArgsInput): { argv: string[] } {
    const options = supportsInlineSettings(cliVersion)
      ? forceInlineSettings(profileOptionArgs)
      : profileOptionArgs;
    if (mode === 'restore') {
      // Interactive TUI restore. DB watcher updates live once re-emitted with
      // providerSessionId by the restore pipeline.
      return { argv: ['--conversation', providerSessionId!, ...options] };
    }

    // New session. Seed the initial prompt via argv when present; the pipeline
    // leaves `initialPrompt` undefined when no prompt is configured.
    if (initialPrompt) {
      return { argv: ['--prompt-interactive', initialPrompt, ...options] };
    }
    return { argv: [...options] };
  }

  async createSavePoint(input: CreateSessionSavePointInput): Promise<SessionSavePointCopy> {
    return this.copyConversation(input);
  }

  async prepareForkLaunch(input: PrepareSessionForkLaunchInput): Promise<SessionForkLaunchResult> {
    const child = await this.copyConversation(input);
    return {
      ...child,
      ...this.buildLaunchArgs({
        mode: 'restore',
        providerSessionId: child.providerSessionId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        cliVersion: input.cliVersion,
        // Go's flag parser accepts one or two dashes before the same option name.
        profileOptionArgs: stripPromptFlags(input.profileOptionArgs, {
          valueFlags: ['i', 'p', 'prompt-interactive', 'print', 'prompt'].flatMap((name) => [
            `-${name}`,
            `--${name}`,
          ]),
        }),
        env: input.env,
      }),
    };
  }

  private async copyConversation({
    providerSessionId: sourceId,
    transcriptPath: sourceDbPath,
  }: CreateSessionSavePointInput) {
    const conversations = dirname(sourceDbPath);
    if (
      !/^[a-z0-9][a-z0-9-]*$/i.test(sourceId) ||
      basename(conversations) !== 'conversations' ||
      basename(sourceDbPath) !== `${sourceId}.db`
    ) {
      throw new ValidationError(
        'The Antigravity transcript path does not match the conversation ID',
      );
    }

    const store = dirname(conversations);
    const brain = join(store, 'brain');
    const sourceBrain = join(brain, sourceId);
    if (!(await lstat(sourceBrain)).isDirectory()) {
      throw new IOError('The Antigravity brain path must be a directory');
    }

    const providerSessionId = randomUUID();
    const transcriptPath = join(conversations, `${providerSessionId}.db`);
    const childBrain = join(brain, providerSessionId);
    const staging = await mkdtemp(join(store, '.devchain-copy-'));
    const stagedDb = join(staging, 'conversation.db');
    const stagedBrain = join(staging, 'brain');
    try {
      const source = new Database(sourceDbPath, { readonly: true, fileMustExist: true });
      try {
        await source.backup(stagedDb);
      } finally {
        source.close();
      }
      const copy = new Database(stagedDb, { fileMustExist: true });
      try {
        // The CLI can open every conversation DB on startup and switch it to WAL mode.
        copy.pragma('journal_mode = WAL');
        const result = copy
          .prepare('UPDATE trajectory_meta SET cascade_id = ? WHERE cascade_id = ?')
          .run(providerSessionId, sourceId);
        if (result.changes !== 1) {
          throw new IOError('The Antigravity database must contain the source conversation ID');
        }
      } finally {
        copy.close();
      }
      await chmod(stagedDb, 0o600);
      await cp(sourceBrain, stagedBrain, { recursive: true, verbatimSymlinks: true });
      const entries = await readdir(stagedBrain, { recursive: true, withFileTypes: true });
      if (entries.some((entry) => entry.isSymbolicLink())) {
        throw new ValidationError(
          'Antigravity brain directories with symbolic links cannot be copied',
        );
      }
      await rename(stagedBrain, childBrain);
      try {
        await rename(stagedDb, transcriptPath);
      } catch (error) {
        await rm(childBrain, { recursive: true, force: true });
        throw error;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return {
      providerSessionId,
      transcriptPath,
      discardUnboundTranscript: async () => {
        await Promise.all([
          rm(transcriptPath, { force: true }),
          rm(`${transcriptPath}-wal`, { force: true }),
          rm(`${transcriptPath}-shm`, { force: true }),
          rm(childBrain, { recursive: true, force: true }),
        ]);
      },
    };
  }

  /**
   * Pre-write workspace trust so the agy TUI launches non-interactively (no trust
   * prompt). Delegates to the dedicated `AntigravityTrustedWorkspacesService`
   * (both trust stores). Never throws: failures are surfaced as provisioning
   * warnings so a trust hiccup doesn't fail the whole project lifecycle op.
   * Launch permission flags do not bypass the TUI's workspace trust prompt.
   */
  async provisionProjectPath(projectPath: string): Promise<ProvisioningResult> {
    try {
      const result = await this.trustedWorkspaces.ensure(projectPath);
      return { success: true, warnings: result.warnings };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: true,
        warnings: [
          {
            source: 'trusted_workspaces',
            level: 'warn',
            message,
            code: 'AGY_TRUST_PROVISION_FAILED',
          },
        ],
      };
    }
  }

  /**
   * GlobalMcpConfigCapability — parse agy's `~/.gemini/config/mcp_config.json`
   * (`{ "mcpServers": { "<name>": { "serverUrl"|"url": … } } }`) into discovered
   * entries. The home-global file IO lives in `AntigravityMcpRegistrationAdapter`;
   * the schema specifics (root key, transport field) live here. Caller handles
   * JSON parse / empty-file concerns.
   */
  parseGlobalMcpConfig(content: string): McpServerEntry[] {
    const config = JSON.parse(content);
    const servers = config?.mcpServers;
    if (!servers || typeof servers !== 'object') return [];

    const entries: McpServerEntry[] = [];
    for (const [alias, serverConfig] of Object.entries(servers)) {
      const cfg = serverConfig as Record<string, unknown>;
      // Remote MCP servers use `serverUrl` (agy's required field); accept a
      // legacy `url` defensively when discovering pre-existing entries.
      const endpoint = typeof cfg?.serverUrl === 'string' ? cfg.serverUrl : cfg?.url;
      if (typeof endpoint === 'string') {
        entries.push({ alias, endpoint, transport: 'HTTP' });
      }
    }
    return entries;
  }

  /**
   * GlobalMcpConfigCapability — build the per-server entry written under the
   * config's `mcpServers` map. devchain's MCP server is a remote HTTP endpoint, so
   * it is expressed via `serverUrl` (spike + capture: `url`/`httpUrl` are ignored).
   */
  buildGlobalMcpServerEntry(options: AddMcpServerOptions): {
    key: string;
    value: Record<string, unknown>;
  } {
    return {
      key: options.alias ?? 'devchain',
      value: { serverUrl: options.endpoint },
    };
  }
}

function supportsInlineSettings(cliVersion: string | undefined): boolean {
  const version = cliVersion === undefined ? null : parseVersion(cliVersion);
  return version !== null && compareVersions(version, AGY_INLINE_SETTINGS_MIN_VERSION) >= 0;
}

interface SettingsOccurrence {
  index: number;
  /** 1 for `--settings=<value>` or a bare trailing flag, 2 for `--settings <value>`. */
  length: 1 | 2;
  /** Undefined for a bare trailing flag. */
  value: string | undefined;
}

/**
 * The boolean flags of agy 1.5.18 (`agy --<flag>=x help` answers "invalid boolean value").
 * Every other agy flag takes the next argument as its value.
 */
const AGY_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'c',
  'continue',
  'dangerously-skip-permissions',
  'disable-slash-commands',
  'new-project',
  'remote-agent',
  'remote-control',
  'sandbox',
]);

/**
 * The `--settings` / `-settings` occurrences that agy parses, in order. Like Go's flag parser,
 * it gives a non-boolean flag the next argument whatever it looks like, and stops at `--` or
 * at the first argument that is not a flag.
 */
function findSettingsOccurrences(args: readonly string[]): SettingsOccurrence[] {
  const occurrences: SettingsOccurrence[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--' || arg.length < 2 || !arg.startsWith('-')) break;
    const [, name, inlineValue] = /^--?([^=]*)(?:=(.*))?$/s.exec(arg)!;
    const takesNext = inlineValue === undefined && !AGY_BOOLEAN_FLAGS.has(name);
    const value = takesNext ? args[index + 1] : inlineValue;
    if (name === 'settings') {
      occurrences.push({ index, length: takesNext && value !== undefined ? 2 : 1, value });
    }
    if (takesNext) index += 1;
  }
  return occurrences;
}

/** The user's inline settings object; null when agy would read the value as a file path. */
function parseInlineSettings(value: string): Record<string, unknown> | null {
  // `trim` also removes a BOM. agy 1.5.18 reads a BOM-prefixed `--settings` value as a file
  // path, so DevChain strips it here and passes clean JSON.
  const text = value.trim();
  // agy ignores an empty value.
  if (text === '') return {};
  if (!text.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Forces `altScreenMode: "never"` through `--settings`, because DevChain runs agy as an inline
 * terminal app. Only the last `--settings` applies in agy, and `--settings` keys go on top of the
 * saved `settings.json`. A settings file path stays unchanged: DevChain does not read it.
 */
function forceInlineSettings(args: readonly string[]): string[] {
  const occurrences = findSettingsOccurrences(args);
  const effective = occurrences.at(-1);
  if (!effective) {
    return ['--settings', JSON.stringify({ altScreenMode: 'never' }), ...args];
  }
  const settings = effective.value === undefined ? null : parseInlineSettings(effective.value);
  if (!settings) {
    logger.warn(
      { bareFlag: effective.value === undefined },
      'agy --settings is not an inline JSON object; inline mode is not forced',
    );
    return [...args];
  }
  const merged = JSON.stringify({ ...settings, altScreenMode: 'never' });
  const dropped = new Set(
    occurrences.flatMap(({ index, length }) => (length === 2 ? [index, index + 1] : [index])),
  );
  return args.flatMap((arg, index) => {
    if (index === effective.index) return ['--settings', merged];
    return dropped.has(index) ? [] : [arg];
  });
}
