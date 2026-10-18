import { getProviderCliNoUpdateOptions } from './provider-cli-policy';
import { Injectable } from '@nestjs/common';
import { CODEX_TRAITS } from './codex.traits';
import type {
  ProviderAdapter,
  AddMcpServerOptions,
  McpServerEntry,
  LaunchInitialPromptBehavior,
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
import type { ProviderPluginCatalogEntry } from '../dtos/provider-plugin.dto';
import { ensureCodexProjectTrusted } from '../utils/codex-config';
import {
  isRecord,
  optionalBoolean,
  optionalString,
  requireArray,
  requireRecord,
  requireString,
} from './plugin-catalog.utils';

@Injectable()
export class CodexAdapter
  implements
    ProviderAdapter,
    McpCliCapability,
    TranscriptDiscoveryCapability,
    EffortCapability,
    ProviderPluginCapability,
    ProjectProvisioningCapability,
    SessionCommandCapability
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
