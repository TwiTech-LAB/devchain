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
} from './capabilities';
import type { ProviderPluginCatalogEntry } from '../dtos/provider-plugin.dto';
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
    ProviderPluginCapability
{
  readonly providerName = 'codex';

  // Effort maps to the config key `model_reasoning_effort` (`-c
  // model_reasoning_effort=<value>`). Static seed/endpoint metadata.
  readonly defaultEffortValues = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

  /** Codex config key carrying reasoning effort (set via `-c <key>=<value>`). */
  private static readonly EFFORT_CONFIG_KEY = 'model_reasoning_effort';
  readonly transcriptDiscoveryStrategy = 'all' as const;
  readonly transcriptContentSearchMaxBytes = 65_536;
  readonly contentMatchMaxCandidates = 200;
  readonly providerSessionIdRequiredForRestore = true;
  readonly launchInitialPromptBehavior: LaunchInitialPromptBehavior = {
    preKeys: ['Enter'],
    preDelayMs: 2000,
  };

  /**
   * Config overrides forced onto every interactive Codex launch via the global
   * `-c/--config <key=value>` flag (parsed as TOML, so a bare `false` is a boolean).
   *
   * `check_for_update_on_startup` defaults to `true` in `~/.codex/config.toml`,
   * which makes Codex self-update on startup and can break a session mid-launch.
   * `-c` overrides the value that would otherwise be read from config.toml WITHOUT
   * mutating that user-owned file — it is per-launch and reversible.
   *
   * Placed at the FRONT of argv (top-level global flag, before any subcommand) so
   * it always beats the config.toml value; a profile that explicitly re-adds
   * `-c check_for_update_on_startup=true` still wins under Codex's last-wins
   * duplicate-`-c` resolution, preserving a power-user escape hatch.
   */
  private static readonly LAUNCH_CONFIG_OVERRIDES: readonly string[] = [
    '-c',
    'check_for_update_on_startup=false',
  ];

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
    const overrides = CodexAdapter.LAUNCH_CONFIG_OVERRIDES;
    if (mode === 'restore') {
      // Codex uses a `resume` subcommand; session ID goes LAST after profile args.
      // Config overrides lead as top-level global flags, before the subcommand.
      return { argv: [...overrides, 'resume', ...profileOptionArgs, providerSessionId!] };
    }
    return { argv: [...overrides, ...profileOptionArgs] };
  }

  applyEffort(
    args: string[],
    env: Record<string, string>,
    effortValue: string,
  ): { argv: string[]; env: Record<string, string> } {
    // Codex effort is a `-c model_reasoning_effort=<v>` config override injected
    // into profileOptionArgs. The forced update-check prelude is prepended later
    // in buildLaunchArgs, so the injected effort lands after it — and codex's
    // duplicate-`-c` LAST-wins resolution means the injected value beats any
    // matching raw one (which we also strip first for a deterministic argv).
    //
    // KEY-TARGETED strip: only `-c/--config` pairs whose key is
    // `model_reasoning_effort` are removed. A blanket `-c` strip would kill the
    // forced `check_for_update_on_startup=false` prelude and any unrelated user
    // `-c` keys.
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
   * preserved, so the update-check prelude and unrelated `-c` keys survive.
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
