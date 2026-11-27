import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { DEVIN_TRAITS } from './devin.traits';
import type {
  ProviderAdapter,
  AddMcpServerOptions,
  BuildLaunchArgsInput,
  BuildLaunchArgsResult,
  McpServerEntry,
  RuntimePromptBehavior,
} from './provider-adapter.interface';
import type {
  ConfigFileMcpCapability,
  TranscriptDiscoveryCapability,
  HookCapability,
  HookEnvContext,
  SessionCommandCapability,
} from './capabilities';
import { SESSION_START_SOURCE_ENV } from './capabilities/hook.capability';
import type {
  CreateSessionSavePointInput,
  PrepareSessionForkLaunchInput,
  SessionSavePointCopy,
  SessionForkCapability,
  SessionForkLaunchResult,
} from './capabilities/session-fork.capability';
import {
  DEVIN_STORE_SESSIONS_DIR,
  devinSessionStorePath,
  devinTranscriptPath,
} from '../../../common/devin-transcript-paths';
import { IOError, ValidationError } from '../../../common/errors/error-types';
import { parseJsonc } from '../../../common/jsonc';
import { isRecord } from './plugin-catalog.utils';
import { stripPromptFlags } from './fork-profile-options';

/**
 * Adapter for the Devin CLI (`devin`, npm package `devin`, verified
 * v3000.11.234) — DevChain provider #6. Mental model: a Claude-family
 * file-based reader bound to a DevChain-OWNED transcript via `--export` (not a
 * provider-side store like Copilot's `~/.copilot`).
 *
 * - **Deterministic binding.** Devin has no `--session-id` flag, so the
 *   transcript is bound by pointing `--export` at a DevChain-owned path:
 *   `~/.devchain/provider-transcripts/devin/<sessions.id>.json`. The CLI
 *   rewrites the whole ATIF conversation there after every turn, and
 *   `devin -r <id> --export <newpath>` re-binds a RESTORE to the fresh path
 *   with the full old+new conversation — so `sessionId` is read on BOTH modes
 *   (unlike Copilot, which ignores it on restore). `transcriptDiscoveryStrategy
 *   = 'first'`: the reader derives the path from `sessions.id`, zero-scan.
 * - **Restore via `-r/--resume`** (`providerSessionIdRequiredForRestore`):
 *   Devin session ids are names like `functional-share`, surfaced from the
 *   export's top-level `session_id` — NOT the devchain id that names the file.
 * - **Argv prompt seeding.** `devin [OPTIONS] -- <PROMPT>` starts an
 *   interactive session; the prompt must come after `--`, at the end of argv.
 * - **Session store per project.** Every launch and restore runs with
 *   `DEVIN_SESSION_STORE=files` and `DEVIN_SESSIONS_DIR=<devin transcript
 *   root>/stores/<projectId>` (needs Devin 3000.11.205+). Connect and
 *   Disconnect copy the store's session files with the export, so `--resume`
 *   finds the session on the other side.
 * - **Workspace trust.** `--respect-workspace-trust false` skips the trust
 *   prompt on every launch/restore — no pre-written trust file needed.
 * - **Terminal.** Interactive Devin uses no alternate screen (proof P7 in
 *   `scripts/remote-proofs/devin.md`), so `terminalOutputBehavior` stays unset.
 * - **MCP is config-file mode, NOT CLI mode.** `devin mcp remove` refuses
 *   entries owned by FOREIGN configs (devin aggregates other tools' files, e.g.
 *   the project's `opencode.json`), so a drift-repair remove would abort the
 *   whole launch. We therefore read/write the project-local
 *   `<cwd>/.devin/mcp_config.local.json` directly — the exact file
 *   `devin mcp add` (default local scope) produces:
 *   `{ "mcpServers": { "<name>": { "url": "…", "transport": "http" } } }`.
 *
 * No `provider-cli-policy` entry: Devin has no flag or env that switches its
 * updater off (only `auto_update` in the user config), and DevChain-managed
 * npm installs do not update themselves (proof P11), so the default (no-op)
 * branch applies. No EffortCapability — Devin encodes effort in the model id
 * itself (`…-xhigh`, `…-max`).
 */
@Injectable()
export class DevinAdapter
  implements
    ProviderAdapter,
    ConfigFileMcpCapability,
    TranscriptDiscoveryCapability,
    HookCapability,
    SessionCommandCapability,
    SessionForkCapability
{
  readonly providerName = 'devin';
  readonly traits = DEVIN_TRAITS;
  // Sent while busy, Devin queues `/compact` and runs it after the current turn.
  readonly sessionCommands = { compact: '/compact' } as const;

  // The prompt is seeded at launch as the argv tail after `--` (interactive
  // session; the shared pipeline renders it before resolveLaunchConfig).
  readonly initialPromptSeedMode = 'argv' as const;

  // The reader derives the export path from `sessions.id` — discovery takes the
  // first (only) derived candidate.
  readonly transcriptDiscoveryStrategy = 'first' as const;
  readonly providerSessionIdRequiredForRestore = true;
  // The export is written after each turn (and only after the Stop hook).
  readonly transcriptAppearsAfterTurn = true;
  readonly runtimePromptBehavior: RuntimePromptBehavior = { inputPromptMarker: '❭' };
  readonly forkReadsSavePointTranscript = true;

  // ── ConfigFileMcpCapability ──────────────────────────────────────────────
  // `mcpMode = 'project_config'` routes MCP ensure/preflight through
  // ConfigFileMcpRegistrationAdapter (file IO) instead of the CLI adapter —
  // see the class docblock for why `devin mcp remove` cannot be used.
  // `configFileName` is relative to the project root (path.join handles the
  // `.devin/` subdir); `.local.json` is devin's uncommitted local scope, the
  // same file `devin mcp add` writes by default.
  readonly mcpMode = 'project_config' as const;
  readonly configFileName = '.devin/mcp_config.local.json';
  readonly mcpConfigRootKey = 'mcpServers' as const;
  // Devin documents comments in its config files.
  readonly configFileAllowsComments = true;
  // The file holds DevChain's loopback URL. Devin itself excludes it from git
  // only when `devin mcp add` writes it; DevChain writes it at project create,
  // import and launch, so it adds the same exclude after each write.
  readonly excludeConfigFileFromGit = true;

  // ── HookCapability (3rd adopter; Claude-compatible hook JSON) ─────────────
  // Hooks provide the native provider session id before the first export
  // exists. Discovery derives the path from `--export` and retries on idle
  // because Devin may only materialize the file after a turn completes.
  readonly hooksEnabled = true as const;
  // Devin's stdin payload carries no `transcript_path`; the reader derives it.
  readonly hooksProvideTranscriptPath = false;
  readonly managedHookEnvKeys = [SESSION_START_SOURCE_ENV] as const;

  // Same DEVCHAIN_* env contract as Claude, plus a provider tag so relays that
  // run under BOTH providers' hook configs (Devin also executes the project's
  // .claude hooks) can tell which relay family should handle the event.
  buildHookEnv(context: HookEnvContext): Record<string, string> {
    return {
      DEVCHAIN_API_URL: context.apiUrl,
      DEVCHAIN_PROJECT_ID: context.projectId,
      DEVCHAIN_AGENT_ID: context.agentId,
      DEVCHAIN_SESSION_ID: context.sessionId,
      DEVCHAIN_TMUX_SESSION_NAME: context.tmuxSessionName,
      DEVCHAIN_HOOK_PROVIDER: this.providerName,
      ...(context.sessionStartSource && {
        [SESSION_START_SOURCE_ENV]: context.sessionStartSource,
      }),
    };
  }

  buildLaunchArgs({
    mode,
    providerSessionId,
    sessionId,
    projectId,
    profileOptionArgs,
    initialPrompt,
    env: inputEnv,
  }: BuildLaunchArgsInput): BuildLaunchArgsResult {
    if (!sessionId) {
      throw new Error(
        'Devin launch requires the devchain sessionId to bind its --export transcript path',
      );
    }
    if (!projectId) {
      throw new Error('Devin launch requires the projectId to select its session store');
    }
    // The session reader creates the export folder at app start; Devin creates
    // a missing store folder itself.
    const exportPath = devinTranscriptPath(os.homedir(), sessionId);
    const env = {
      ...inputEnv,
      DEVIN_SESSION_STORE: 'files',
      DEVIN_SESSIONS_DIR: devinSessionStorePath(os.homedir(), projectId),
    };

    const commonArgs = [
      '--export',
      exportPath,
      '--respect-workspace-trust',
      'false',
      ...profileOptionArgs,
    ];

    if (mode === 'restore') {
      // `devin -r <id> --export <newpath>` re-writes the FULL conversation (old
      // + new turns) to the fresh path — the restore re-binds deterministically.
      return { argv: ['--resume', providerSessionId!, ...commonArgs], env };
    }

    // New: interactive launch with an optional prompt seeded after `--`.
    const argv = commonArgs;
    if (initialPrompt) {
      argv.push('--', initialPrompt);
    }
    return { argv, env };
  }

  async createSavePoint(input: CreateSessionSavePointInput): Promise<SessionSavePointCopy> {
    const { providerSessionId, transcriptPath, discardUnboundTranscript } = await this.copySession(
      input,
      false,
    );
    return { providerSessionId, transcriptPath, discardUnboundTranscript };
  }

  async prepareForkLaunch(input: PrepareSessionForkLaunchInput): Promise<SessionForkLaunchResult> {
    const child = await this.copySession(input, true);
    try {
      const separator = input.profileOptionArgs.indexOf('--');
      const options =
        separator === -1 ? input.profileOptionArgs : input.profileOptionArgs.slice(0, separator);
      return {
        ...child,
        ...this.buildLaunchArgs({
          mode: 'restore',
          providerSessionId: child.providerSessionId,
          sessionId: input.sessionId,
          projectId: input.projectId,
          profileOptionArgs: stripPromptFlags(options, {
            valueFlags: ['--prompt-file'],
            optionalValueFlags: ['-p', '--print'],
            shortFlags: {
              boolean: ['c', 'h', 'V'],
              takesValue: ['p', 'r'],
            },
          }),
          env: input.env,
        }),
      };
    } catch (error) {
      await child.discardUnboundTranscript().catch(() => undefined);
      throw error;
    }
  }

  /**
   * With `protectExport`, an export that exists at the target path is backed up before the copy
   * replaces it: discard puts the backup back, commit deletes it.
   */
  private async copySession(
    {
      providerSessionId: sourceId,
      projectId,
      sessionId,
      transcriptPath: sourceExport,
    }: CreateSessionSavePointInput,
    protectExport: boolean,
  ) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(sourceId)) {
      throw new ValidationError('Invalid Devin source session ID.');
    }
    const home = os.homedir();
    const sessionsDir = join(devinSessionStorePath(home, projectId), DEVIN_STORE_SESSIONS_DIR);
    const source = join(sessionsDir, sourceId);
    const sourceMeta = join(source, 'meta.json');
    const sourceLog = join(source, 'log.jsonl');
    if (!(await lstat(source)).isDirectory()) {
      throw new IOError('Devin source session store is not a directory.');
    }
    const [metaStat, logStat] = await Promise.all([lstat(sourceMeta), lstat(sourceLog)]);
    if (!metaStat.isFile() || !logStat.isFile()) {
      throw new IOError('Devin session metadata and log must be regular files.');
    }

    const providerSessionId = randomUUID();
    const transcriptPath = devinTranscriptPath(home, sessionId);
    const target = join(sessionsDir, providerSessionId);
    const [meta, transcript] = await Promise.all([
      readFile(sourceMeta, 'utf8'),
      readFile(sourceExport, 'utf8'),
    ]);
    const copiedMeta = rewriteCopyId(meta, 'id', sourceId, providerSessionId);
    const copiedTranscript = rewriteCopyId(transcript, 'session_id', sourceId, providerSessionId);
    const stagedStore = await mkdtemp(join(sessionsDir, '.devchain-copy-'));
    const stagedExport = `${transcriptPath}.${providerSessionId}.tmp`;
    let backup: string | null = null;
    let storePublished = false;
    try {
      await copyFile(sourceLog, join(stagedStore, 'log.jsonl'));
      await writeFile(join(stagedStore, 'meta.json'), copiedMeta, { mode: 0o600 });
      await writeFile(stagedExport, copiedTranscript, { mode: 0o600, flag: 'wx' });
      await rename(stagedStore, target);
      storePublished = true;
      if (protectExport) backup = await backupExport(transcriptPath, providerSessionId);
      await rename(stagedExport, transcriptPath);
    } catch (error) {
      await Promise.allSettled([
        rm(storePublished ? target : stagedStore, { recursive: true, force: true }),
        rm(stagedExport, { force: true }),
        ...(backup ? [rm(backup, { force: true })] : []),
      ]);
      throw error;
    }
    const backupPath = backup;
    return {
      providerSessionId,
      transcriptPath,
      discardUnboundTranscript: async () => {
        await Promise.all([
          rm(target, { recursive: true, force: true }),
          backupPath ? rename(backupPath, transcriptPath) : rm(transcriptPath, { force: true }),
        ]);
      },
      ...(backupPath && {
        commitBoundTranscript: () => rm(backupPath, { force: true }),
      }),
    };
  }

  /**
   * Parse MCP entries from `.devin/mcp_config.local.json` content (JSON with
   * comments). Throws `SyntaxError` on invalid content; the caller handles it.
   *
   * Only URL-bearing entries are returned: devin's file mixes transports under
   * one `mcpServers` map — remote servers carry `{ "url": …, "transport": … }`
   * while stdio servers carry `{ "command": …, "args": […] }` with no `url`,
   * and stdio entries have no endpoint to compare against the devchain URL.
   */
  parseProjectConfig(content: string): McpServerEntry[] {
    const config = parseJsonc(content) as Record<string, unknown> | null;
    const servers = config?.[this.mcpConfigRootKey];
    if (!servers || typeof servers !== 'object') return [];

    const entries: McpServerEntry[] = [];
    for (const [alias, serverConfig] of Object.entries(servers)) {
      const cfg = serverConfig as Record<string, unknown> | null;
      if (typeof cfg?.url === 'string') {
        entries.push({
          alias,
          endpoint: cfg.url,
          transport: typeof cfg.transport === 'string' ? cfg.transport.toUpperCase() : 'HTTP',
        });
      }
    }
    return entries;
  }

  /**
   * Build the MCP config entry written under the file's `mcpServers` map —
   * byte-identical to what `devin mcp add --transport http <name> <url>`
   * produces for the local project scope.
   */
  buildMcpConfigEntry(options: AddMcpServerOptions): {
    key: string;
    value: Record<string, unknown>;
  } {
    return {
      key: options.alias ?? 'devchain',
      value: { url: options.endpoint, transport: 'http' },
    };
  }
}

function rewriteCopyId(
  content: string,
  key: 'id' | 'session_id',
  sourceId: string,
  targetId: string,
): string {
  let record: unknown;
  try {
    record = JSON.parse(content);
  } catch {
    throw new IOError('Devin session metadata or export is not valid JSON.');
  }
  if (!isRecord(record) || record[key] !== sourceId) {
    throw new IOError('Devin session metadata or export has a different session ID.');
  }
  return JSON.stringify({ ...record, [key]: targetId });
}

/** Returns the backup path, or null when no export exists at `exportPath`. */
async function backupExport(exportPath: string, copyId: string): Promise<string | null> {
  const backupPath = `${exportPath}.${copyId}.bak`;
  try {
    await copyFile(exportPath, backupPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return backupPath;
}
