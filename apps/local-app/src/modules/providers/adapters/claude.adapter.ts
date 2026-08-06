import { Injectable } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type {
  ProviderAdapter,
  AddMcpServerOptions,
  McpServerEntry,
  LaunchInitialPromptBehavior,
  TerminalOutputBehavior,
  BuildLaunchArgsInput,
} from './provider-adapter.interface';
import type {
  McpCliCapability,
  AutoCompactCapability,
  AutoCompactProviderState,
  EffortCapability,
  HookCapability,
  HookEnvContext,
  TranscriptDiscoveryCapability,
  ProjectMcpSettingsCapability,
  ProviderPluginCapability,
} from './capabilities';
import type { ProviderPluginCatalogEntry } from '../dtos/provider-plugin.dto';
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  parseProviderPluginCatalogPayload,
  parseQualifiedPluginId,
  requireString,
} from './plugin-catalog.utils';

import { stripFlag } from '../../sessions/utils/profile-options';

interface ClaudeSettingsLocal {
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
  [key: string]: unknown;
}

@Injectable()
export class ClaudeAdapter
  implements
    ProviderAdapter,
    McpCliCapability,
    AutoCompactCapability,
    EffortCapability,
    HookCapability,
    TranscriptDiscoveryCapability,
    ProjectMcpSettingsCapability,
    ProviderPluginCapability
{
  readonly providerName = 'claude';

  // Effort (`--effort <value>`): Claude's CLI accepts these and falls back
  // gracefully on unsupported values, so `max` is still seeded even though it is
  // model/CLI-dependent. Static seed/endpoint metadata — not derived at launch.
  readonly defaultEffortValues = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

  readonly launchInitialPromptBehavior: LaunchInitialPromptBehavior = {
    preKeys: ['Enter'],
    preDelayMs: 2000,
  };

  // Claude's fullscreen renderer previously needed raw LF handling while
  // CLAUDE_CODE_NO_FLICKER was forced. With that env removed, normalize LF like
  // other providers so xterm receives CRLF replay semantics consistently.
  readonly terminalOutputBehavior: TerminalOutputBehavior = { rawLineEndings: false };

  // Claude's fullscreen renderer takes a degraded code path when it detects $TMUX
  // (cell-diff updates without ESC[K cleanup, leaving stale cells that drift into
  // scrollback). Unsetting both vars forces the full non-multiplexer renderer.
  readonly launchUnsetEnv = ['TMUX', 'TMUX_PANE'] as const;

  readonly transcriptDiscoveryStrategy = 'first' as const;
  readonly transcriptContentSearchMaxBytes = 16_384;

  readonly hooksEnabled = true as const;
  readonly hooksEventName = 'claude.hooks.session.started';
  readonly hooksProvideTranscriptPath = true;

  listProviderPlugins(): string[] {
    return ['plugin', 'list', '--available', '--json'];
  }

  installProviderPlugin(pluginId: string): string[] {
    return ['plugin', 'install', pluginId, '--scope', 'user'];
  }

  parseProviderPluginCatalog(stdout: string): ProviderPluginCatalogEntry[] {
    const payload = parseProviderPluginCatalogPayload(stdout, this.providerName);
    const entries = new Map<string, ProviderPluginCatalogEntry>();

    for (const available of payload.available) {
      const pluginId = requireString(available, 'pluginId', 'Claude available plugin');
      entries.set(pluginId, {
        pluginId,
        name: requireString(available, 'name', `Claude plugin ${pluginId}`),
        description: optionalString(available, 'description'),
        marketplaceName: optionalString(available, 'marketplaceName'),
        version: optionalString(available, 'version'),
        installed: false,
        available: true,
        providerEnabled: false,
        installationScopes: [],
        installCount: optionalNumber(available, 'installCount'),
        installPolicy: null,
        authPolicy: null,
      });
    }

    for (const installed of payload.installed) {
      const pluginId = requireString(installed, 'id', 'Claude installed plugin');
      const existing = entries.get(pluginId);
      const identity = parseQualifiedPluginId(pluginId);
      const scope = optionalString(installed, 'scope');
      const installationScopes = existing ? [...existing.installationScopes] : [];
      if (scope && !installationScopes.includes(scope)) {
        installationScopes.push(scope);
      }

      entries.set(pluginId, {
        pluginId,
        name: existing?.name ?? identity.name,
        description: existing?.description ?? null,
        marketplaceName: existing?.marketplaceName ?? identity.marketplaceName,
        version: optionalString(installed, 'version') ?? existing?.version ?? null,
        installed: true,
        available: existing?.available ?? false,
        providerEnabled:
          (existing?.providerEnabled ?? false) || optionalBoolean(installed, 'enabled'),
        installationScopes,
        installCount: existing?.installCount ?? null,
        installPolicy: null,
        authPolicy: null,
      });
    }

    return [...entries.values()];
  }

  buildHookEnv(context: HookEnvContext): Record<string, string> {
    return {
      DEVCHAIN_API_URL: context.apiUrl,
      DEVCHAIN_PROJECT_ID: context.projectId,
      DEVCHAIN_AGENT_ID: context.agentId,
      DEVCHAIN_SESSION_ID: context.sessionId,
      DEVCHAIN_TMUX_SESSION_NAME: context.tmuxSessionName,
    };
  }

  applyAutoCompactConfig(
    args: string[],
    env: Record<string, string>,
    provider: AutoCompactProviderState,
  ): { argv: string[]; env: Record<string, string> } {
    const resultEnv = { ...env };

    if (
      resultEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE === undefined &&
      provider.autoCompactThreshold != null
    ) {
      resultEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(provider.autoCompactThreshold);
    }

    return { argv: [...args], env: resultEnv };
  }

  applyEffort(
    args: string[],
    env: Record<string, string>,
    effortValue: string,
  ): { argv: string[]; env: Record<string, string> } {
    // Strip any raw `--effort` (both `--effort v` and `--effort=v` forms) so the
    // structured value can't be contradicted, then inject the native flag. Env is
    // untouched (Claude's effort is an argv flag, not an env overlay).
    const stripped = stripFlag(args, '--effort');
    return { argv: ['--effort', effortValue, ...stripped], env };
  }

  async evaluateAutoCompactConfig(): Promise<{ enabled: boolean; reason?: string }> {
    const { checkAutoCompactConfig } = await import('../../sessions/utils/claude-config');
    const { autoCompactEnabled, configState } = await checkAutoCompactConfig();
    if (configState === 'malformed') {
      return { enabled: true };
    }
    return {
      enabled: autoCompactEnabled,
      reason: autoCompactEnabled ? undefined : 'auto_compact_disabled',
    };
  }

  async ensureProjectSettings(projectPath: string): Promise<void> {
    const settingsDir = join(projectPath, '.claude');
    const settingsPath = join(settingsDir, 'settings.local.json');
    const permission = 'mcp__devchain';

    await mkdir(settingsDir, { recursive: true });

    let settings: ClaudeSettingsLocal;
    try {
      const content = await readFile(settingsPath, 'utf-8');
      settings = JSON.parse(content);
    } catch {
      settings = { permissions: { allow: [], deny: [], ask: [] } };
    }

    if (!settings.permissions) {
      settings.permissions = { allow: [], deny: [], ask: [] };
    }
    if (!Array.isArray(settings.permissions.allow)) {
      settings.permissions.allow = [];
    }

    if (!settings.permissions.allow.includes(permission)) {
      settings.permissions.allow.push(permission);
      await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    }
  }

  addMcpServer(options: AddMcpServerOptions): string[] {
    const alias = options.alias ?? this.providerName;
    const args = ['mcp', 'add', '--transport', 'http', alias, options.endpoint];
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
    if (mode === 'restore') {
      return { argv: ['--resume', providerSessionId!, ...profileOptionArgs] };
    }
    return { argv: [...profileOptionArgs] };
  }

  parseListOutput(stdout: string, _stderr?: string): McpServerEntry[] {
    // Claude CLI output format:
    // Checking MCP server health...
    //
    // devchain: http://127.0.0.1:3000/mcp (HTTP) - ✓ Connected
    // claude: ws://127.0.0.1:4000 (HTTP) - ✗ Failed to connect
    const entries: McpServerEntry[] = [];
    const lines = stdout.split('\n').filter((line) => line.trim().length > 0);

    for (const line of lines) {
      // Skip header lines (e.g., "Checking MCP server health...")
      if (line.toLowerCase().startsWith('checking')) {
        continue;
      }

      // Parse format: "alias: endpoint (transport) - status"
      const match = line.match(/^(\S+):\s+(\S+)\s+\(([^)]+)\)/);
      if (match) {
        const [, alias, endpoint, transport] = match;
        entries.push({
          alias,
          endpoint,
          transport: transport.toUpperCase(),
        });
      }
    }

    return entries;
  }
}
