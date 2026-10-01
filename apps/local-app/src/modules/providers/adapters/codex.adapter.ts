import { getProviderCliNoUpdateOptions } from './provider-cli-policy';
import { Injectable } from '@nestjs/common';
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
  ProjectProvisioningCapability,
  ProjectProvisioningContext,
  ProvisioningResult,
} from './capabilities';
import type { ProviderPluginCatalogEntry } from '../dtos/provider-plugin.dto';
import { ensureCodexProjectTrusted } from '../../sessions/utils/codex-config';
import {
  optionalBoolean,
  optionalString,
  parseProviderPluginCatalogPayload,
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
    ProjectProvisioningCapability
{
  readonly providerName = 'codex';
  readonly requiresProjectProvisioning = true as const;

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

  listProviderPlugins(): string[] {
    return ['plugin', 'list', '--available', '--json'];
  }

  installProviderPlugin(pluginId: string): string[] {
    return ['plugin', 'add', pluginId, '--json'];
  }

  parseProviderPluginCatalog(stdout: string): ProviderPluginCatalogEntry[] {
    const payload = parseProviderPluginCatalogPayload(stdout, this.providerName);
    const entries = new Map<string, ProviderPluginCatalogEntry>();

    for (const available of payload.available) {
      const pluginId = requireString(available, 'pluginId', 'Codex available plugin');
      entries.set(pluginId, this.normalizeProviderPlugin(available, pluginId, true));
    }

    for (const installed of payload.installed) {
      const pluginId = requireString(installed, 'pluginId', 'Codex installed plugin');
      const existing = entries.get(pluginId);
      const normalized = this.normalizeProviderPlugin(
        installed,
        pluginId,
        existing?.available ?? false,
      );
      entries.set(pluginId, {
        ...normalized,
        description: existing?.description ?? normalized.description,
        marketplaceName: normalized.marketplaceName ?? existing?.marketplaceName ?? null,
        available: existing?.available ?? normalized.available,
        installed: true,
        installPolicy: normalized.installPolicy ?? existing?.installPolicy ?? null,
        authPolicy: normalized.authPolicy ?? existing?.authPolicy ?? null,
      });
    }

    return [...entries.values()];
  }

  private normalizeProviderPlugin(
    plugin: Record<string, unknown>,
    pluginId: string,
    available: boolean,
  ): ProviderPluginCatalogEntry {
    return {
      pluginId,
      name: requireString(plugin, 'name', `Codex plugin ${pluginId}`),
      description: optionalString(plugin, 'description'),
      marketplaceName: optionalString(plugin, 'marketplaceName'),
      version: optionalString(plugin, 'version'),
      installed: optionalBoolean(plugin, 'installed'),
      available,
      providerEnabled: optionalBoolean(plugin, 'enabled'),
      installationScopes: [],
      installCount: null,
      installPolicy: optionalString(plugin, 'installPolicy'),
      authPolicy: optionalString(plugin, 'authPolicy'),
    };
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

  binaryCheck(alias: string): string[] {
    return ['mcp', 'check', alias];
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
