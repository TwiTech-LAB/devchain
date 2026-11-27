import { applyProviderCliNoUpdate, getProviderCliNoUpdateOptions } from './provider-cli-policy';
import { Injectable } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { lstat, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'path';
import { CODEX_TRAITS } from './codex.traits';
import { IOError, ValidationError } from '../../../common/errors/error-types';
import {
  isWithin,
  PROVIDER_ROOTS,
} from '../../session-reader/services/transcript-path-validator.service';
import {
  codexRolloutSessionId,
  readCodexRolloutHeader,
} from '../../session-reader/adapters/codex-session-reader.adapter';
import type {
  ProviderAdapter,
  AddMcpServerOptions,
  McpServerEntry,
  LaunchInitialPromptBehavior,
  RuntimePromptBehavior,
  BuildLaunchArgsInput,
} from './provider-adapter.interface';
import type {
  McpCliCapability,
  TranscriptDiscoveryCapability,
  EffortCapability,
  ProviderPluginCapability,
  ProviderPluginCatalogResult,
  ProviderPluginCatalogSource,
  ProjectProvisioningCapability,
  ProjectProvisioningContext,
  ProvisioningResult,
  SessionCommandCapability,
} from './capabilities';
import type {
  CreateSessionSavePointInput,
  PrepareSessionForkLaunchInput,
  SessionForkCapability,
  SessionForkLaunchResult,
  SessionSavePointCopy,
} from './capabilities/session-fork.capability';
import type { ProviderPluginCatalogEntry } from '../dtos/provider-plugin.dto';
import { CodexAppServerClient } from '../services/codex-app-server.client';
import { ensureCodexProjectTrusted } from '../utils/codex-config';
import { stripPositionalPrompt } from './fork-profile-options';
import {
  isRecord,
  optionalBoolean,
  optionalString,
  requireArray,
  requireRecord,
  requireString,
} from './plugin-catalog.utils';

const FORK_TIMEOUT_MS = 60_000;
const FORK_MAX_OUTPUT_BYTES = 1024 * 1024;

@Injectable()
export class CodexAdapter
  implements
    ProviderAdapter,
    McpCliCapability,
    TranscriptDiscoveryCapability,
    EffortCapability,
    ProviderPluginCapability,
    ProjectProvisioningCapability,
    SessionCommandCapability,
    SessionForkCapability
{
  readonly providerName = 'codex';
  readonly traits = CODEX_TRAITS;
  readonly sessionCommands = { compact: '/compact' } as const;

  // Effort maps to the config key `model_reasoning_effort` (`-c
  // model_reasoning_effort=<value>`). Static seed/endpoint metadata.
  readonly defaultEffortValues = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

  /** Codex config key carrying reasoning effort (set via `-c <key>=<value>`). */
  private static readonly EFFORT_CONFIG_KEY = 'model_reasoning_effort';

  /**
   * Keeps the TUI inline so finished output scrolls into tmux history. In its
   * default alternate-screen mode Codex 0.159 redraws the transcript in place
   * (0.156 did not), and tmux history, which xterm seeds from, then holds only
   * the last screen. A Codex without this key ignores it.
   */
  private static readonly INLINE_SCREEN_OVERRIDE = ['-c', 'tui.alternate_screen="never"'];
  readonly transcriptDiscoveryStrategy = 'all' as const;
  readonly transcriptContentSearchMaxBytes = 65_536;
  readonly contentMatchMaxCandidates = 200;
  readonly providerSessionIdRequiredForRestore = true;
  readonly launchInitialPromptBehavior: LaunchInitialPromptBehavior = {
    preKeys: ['Enter'],
    preDelayMs: 2000,
  };
  readonly runtimePromptBehavior: RuntimePromptBehavior = { inputPromptMarker: '›' };

  constructor(private readonly appServer: CodexAppServerClient = new CodexAppServerClient()) {}

  async provisionProjectPath(
    projectPath: string,
    context?: ProjectProvisioningContext,
  ): Promise<ProvisioningResult> {
    const result = await ensureCodexProjectTrusted(projectPath, context);
    if (result.success) return { success: true, warnings: [] };
    return {
      success: false,
      warnings: [
        {
          source: 'codex_project_trust',
          level: 'warn',
          message: result.message,
          code: result.code,
        },
      ],
    };
  }

  providerPluginCatalog(): ProviderPluginCatalogSource {
    return {
      transport: 'app-server',
      args: ['app-server'],
      method: 'plugin/list',
      params: {},
      parse: parseCodexPluginList,
    };
  }

  installProviderPlugin(pluginId: string): string[] {
    return ['plugin', 'add', pluginId, '--json'];
  }

  addMcpServer(options: AddMcpServerOptions): string[] {
    const alias = options.alias ?? this.providerName;
    const args = ['mcp', 'add', '--url', options.endpoint, alias];
    if (options.extraArgs?.length) {
      args.push(...options.extraArgs);
    }
    return args;
  }

  listMcpServers(): string[] {
    return ['mcp', 'list'];
  }

  removeMcpServer(alias: string): string[] {
    return ['mcp', 'remove', alias];
  }

  buildLaunchArgs({ mode, providerSessionId, profileOptionArgs }: BuildLaunchArgsInput): {
    argv: string[];
  } {
    const overrides = [
      ...getProviderCliNoUpdateOptions(this.providerName).args,
      ...CodexAdapter.INLINE_SCREEN_OVERRIDE,
    ];
    if (mode === 'restore') {
      // Codex uses a `resume` subcommand; session ID goes LAST after profile args.
      // The final config override wins over profile args; the session ID stays last.
      return { argv: ['resume', ...profileOptionArgs, ...overrides, providerSessionId!] };
    }
    return { argv: [...profileOptionArgs, ...overrides] };
  }

  async createSavePoint({
    providerSessionId,
    transcriptPath: sourcePath,
    providerBinPath,
    helperEnv,
  }: CreateSessionSavePointInput): Promise<SessionSavePointCopy> {
    const command = applyProviderCliNoUpdate(
      this.providerName,
      [providerBinPath, 'app-server'],
      helperEnv,
    );
    const result = await this.appServer.request({
      ...command,
      method: 'thread/fork',
      params: { threadId: providerSessionId, excludeTurns: true },
      timeoutMs: FORK_TIMEOUT_MS,
      maxOutputBytes: FORK_MAX_OUTPUT_BYTES,
    });
    if (!isRecord(result) || !isRecord(result.thread)) {
      throw new IOError('Codex thread/fork returned no thread');
    }
    const { id, path: transcriptPath } = result.thread;
    if (
      typeof id !== 'string' ||
      !id.trim() ||
      id === providerSessionId ||
      typeof transcriptPath !== 'string' ||
      !isAbsolute(transcriptPath)
    ) {
      throw new IOError('Codex thread/fork returned an invalid ID or rollout path');
    }
    return {
      providerSessionId: id,
      transcriptPath,
      discardUnboundTranscript: () => discardForkedRollout(id, transcriptPath, sourcePath),
    };
  }

  async prepareForkLaunch(input: PrepareSessionForkLaunchInput): Promise<SessionForkLaunchResult> {
    const child = await this.createSavePoint(input);
    const { argv } = this.buildLaunchArgs({
      mode: 'restore',
      providerSessionId: child.providerSessionId,
      profileOptionArgs: stripPositionalPrompt(input.profileOptionArgs, {
        valueFlags: [
          '-c',
          '--config',
          '--enable',
          '--disable',
          '--remote',
          '--remote-auth-token-env',
          '-m',
          '--model',
          '--local-provider',
          '-p',
          '--profile',
          '-s',
          '--sandbox',
          '-C',
          '--cd',
          '--add-dir',
          '-a',
          '--ask-for-approval',
        ],
        // Codex submits an image-only user message even when there is no text prompt.
        variadicPromptFlags: ['-i', '--image'],
      }),
    });
    return { ...child, argv };
  }

  applyEffort(
    args: string[],
    env: Record<string, string>,
    effortValue: string,
  ): { argv: string[]; env: Record<string, string> } {
    // Strip only the effort key: unrelated config (including update policy) must
    // survive. buildLaunchArgs appends the authoritative no-update override.
    const stripped = CodexAdapter.stripConfigKey(args, CodexAdapter.EFFORT_CONFIG_KEY);
    return {
      argv: ['-c', `${CodexAdapter.EFFORT_CONFIG_KEY}=${effortValue}`, ...stripped],
      env,
    };
  }

  /**
   * Remove every `-c`/`--config <key=value>` PAIR (the flag token AND its value
   * token) whose key equals `key`. Two-token form only — codex config overrides
   * are always `-c <key>=<value>`. Non-matching keys and every other token are
   * preserved, so unrelated `-c` keys survive.
   */
  private static stripConfigKey(args: string[], key: string): string[] {
    const result: string[] = [];

    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];

      if ((arg === '-c' || arg === '--config') && i + 1 < args.length) {
        const value = args[i + 1];
        const eqIndex = value.indexOf('=');
        const valueKey = eqIndex === -1 ? value : value.slice(0, eqIndex);
        if (valueKey === key) {
          i += 1; // skip the value token as well
          continue;
        }
      }

      result.push(arg);
    }

    return result;
  }

  parseListOutput(stdout: string, _stderr?: string): McpServerEntry[] {
    // Codex CLI output format (example):
    // devchain  http://127.0.0.1:3000/mcp
    //
    // Parse line-by-line, split by whitespace
    const entries: McpServerEntry[] = [];
    const lines = stdout.split('\n').filter((line) => line.trim().length > 0);

    for (const line of lines) {
      // Skip header lines or empty lines
      if (line.toLowerCase().includes('alias') || line.toLowerCase().includes('name')) {
        continue;
      }

      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const alias = parts[0];
        const endpoint = parts[1];

        entries.push({
          alias,
          endpoint,
        });
      }
    }

    return entries;
  }
}

/**
 * Maps a `codex app-server` `plugin/list` result. The same plugin ID can appear more than once;
 * the UI and plugin policy key on the ID, so one entry is kept per ID.
 */
function parseCodexPluginList(result: unknown): ProviderPluginCatalogResult {
  const payload = requireRecord(result, 'codex plugin/list result');
  const entries = new Map<string, ProviderPluginCatalogEntry>();

  const marketplaces = requireArray(payload, 'marketplaces', 'codex plugin/list');
  for (const [index, value] of marketplaces.entries()) {
    const marketplace = requireRecord(value, `codex marketplace ${index}`);
    const marketplaceName = requireString(marketplace, 'name', `codex marketplace ${index}`);
    const context = `codex marketplace ${marketplaceName}`;
    for (const plugin of requireArray(marketplace, 'plugins', context)) {
      const entry = normalizeCodexPlugin(
        requireRecord(plugin, `${context} plugin`),
        marketplaceName,
      );
      const existing = entries.get(entry.pluginId);
      if (!existing || (entry.installed && !existing.installed)) {
        entries.set(entry.pluginId, entry);
      }
    }
  }

  const loadErrors = payload.marketplaceLoadErrors;
  return { entries: [...entries.values()], warnings: Array.isArray(loadErrors) ? loadErrors : [] };
}

function normalizeCodexPlugin(
  plugin: Record<string, unknown>,
  marketplaceName: string,
): ProviderPluginCatalogEntry {
  const pluginId = requireString(plugin, 'id', `codex marketplace ${marketplaceName} plugin`);
  const pluginInterface = isRecord(plugin.interface) ? plugin.interface : {};
  return {
    pluginId,
    name:
      optionalString(pluginInterface, 'displayName') ??
      requireString(plugin, 'name', `codex plugin ${pluginId}`),
    description: optionalString(pluginInterface, 'shortDescription'),
    marketplaceName,
    version: optionalString(plugin, 'version'),
    installed: optionalBoolean(plugin, 'installed'),
    available: plugin.availability !== 'DISABLED_BY_ADMIN',
    providerEnabled: optionalBoolean(plugin, 'enabled'),
    installationScopes: [],
    installCount: null,
    installPolicy: optionalString(plugin, 'installPolicy'),
    authPolicy: optionalString(plugin, 'authPolicy'),
  };
}

/**
 * Removes the rollout that `thread/fork` wrote for `threadId` when DevChain does not store it.
 * Removes only a regular file, never a link, under the Codex transcript root (the same root that
 * stored transcript paths are checked against) whose file name and `session_meta` header both
 * carry `threadId`, and never the source rollout. Anything else is refused and kept.
 */
async function discardForkedRollout(
  threadId: string,
  rolloutPath: string,
  sourcePath: string,
): Promise<void> {
  const refuse = (reason: string) =>
    new ValidationError(`Codex rollout was not discarded: ${reason}`, { rolloutPath });
  let info;
  try {
    info = await lstat(rolloutPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!info.isFile()) throw refuse('not a regular file');
  const real = await realpath(rolloutPath);
  const roots = await Promise.all(
    PROVIDER_ROOTS.codex.map((root) =>
      realpath(resolve(homedir(), root)).catch(() => resolve(homedir(), root)),
    ),
  );
  if (!roots.some((root) => isWithin(root, real))) throw refuse('outside the Codex root');
  const source = await realpath(sourcePath).catch(() => resolve(sourcePath));
  if (real === source) throw refuse('it is the source rollout');
  const id = threadId.toLowerCase();
  if (codexRolloutSessionId(real)?.toLowerCase() !== id) throw refuse('another thread file name');
  const stream = createReadStream(real, { encoding: 'utf8' });
  const header = await readCodexRolloutHeader(stream).finally(() => stream.destroy());
  if (header?.providerSessionId !== id) throw refuse('another thread header');
  await unlink(real);
}
