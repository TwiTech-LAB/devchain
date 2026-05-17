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
  ContextWindowCapability,
  ContextWindowProviderState,
  ModelFamily,
  HookCapability,
  HookEnvContext,
  TranscriptDiscoveryCapability,
  ProjectMcpSettingsCapability,
} from './capabilities';

import { rewriteModelTo1m, extractModelFromArgs } from '../../sessions/utils/profile-options';

interface ClaudeSettingsLocal {
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
  [key: string]: unknown;
}

const CLAUDE_1M_CONTEXT_WINDOW_TOKENS = 1_000_000;

@Injectable()
export class ClaudeAdapter
  implements
    ProviderAdapter,
    McpCliCapability,
    ContextWindowCapability,
    HookCapability,
    TranscriptDiscoveryCapability,
    ProjectMcpSettingsCapability
{
  readonly providerName = 'claude';

  readonly launchInitialPromptBehavior: LaunchInitialPromptBehavior = {
    preKeys: ['Enter'],
    preDelayMs: 2000,
  };

  // Claude's fullscreen renderer previously needed raw LF handling while
  // CLAUDE_CODE_NO_FLICKER was forced. With that env removed, normalize LF like
  // other providers so xterm receives CRLF replay semantics consistently.
  readonly terminalOutputBehavior: TerminalOutputBehavior = { rawLineEndings: false };

  readonly transcriptDiscoveryStrategy = 'first' as const;
  readonly transcriptContentSearchMaxBytes = 16_384;

  readonly hooksEnabled = true as const;
  readonly hooksEventName = 'claude.hooks.session.started';
  readonly hooksProvideTranscriptPath = true;

  buildHookEnv(context: HookEnvContext): Record<string, string> {
    return {
      DEVCHAIN_API_URL: context.apiUrl,
      DEVCHAIN_PROJECT_ID: context.projectId,
      DEVCHAIN_AGENT_ID: context.agentId,
      DEVCHAIN_SESSION_ID: context.sessionId,
      DEVCHAIN_TMUX_SESSION_NAME: context.tmuxSessionName,
    };
  }

  detectModelFamily(modelName: string): ModelFamily {
    const lower = modelName.toLowerCase();
    if (lower.includes('opus')) return 'opus';
    if (lower.includes('sonnet')) return 'sonnet';
    if (lower.includes('haiku')) return 'haiku';
    return null;
  }

  is1mActiveForModel(oneMillionEnabled: boolean, modelName: string): boolean {
    return oneMillionEnabled && this.detectModelFamily(modelName) === 'opus';
  }

  applyContextWindowConfig(
    args: string[],
    env: Record<string, string>,
    provider: ContextWindowProviderState,
  ): { argv: string[]; env: Record<string, string> } {
    let argv = [...args];
    const resultEnv = { ...env };

    if (provider.oneMillionContextEnabled) {
      argv = rewriteModelTo1m(argv);
    }

    if (!resultEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) {
      const modelStr = extractModelFromArgs(argv);
      const threshold = this.getCompactThreshold(modelStr, provider);
      if (threshold != null) {
        resultEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(threshold);
      }
    }

    delete resultEnv.CLAUDE_CODE_DISABLE_1M_CONTEXT;

    return { argv, env: resultEnv };
  }

  getCompactThreshold(
    modelName: string | null,
    provider: ContextWindowProviderState,
  ): number | undefined {
    const family = modelName ? this.detectModelFamily(modelName) : null;
    if (
      provider.oneMillionContextEnabled &&
      family === 'opus' &&
      provider.autoCompactThreshold1m != null
    ) {
      return provider.autoCompactThreshold1m;
    }
    if (provider.autoCompactThreshold != null) {
      return provider.autoCompactThreshold;
    }
    return undefined;
  }

  getReadTimeContextWindow(modelName: string, oneMillionEnabled: boolean): number | undefined {
    if (this.is1mActiveForModel(oneMillionEnabled, modelName)) {
      return CLAUDE_1M_CONTEXT_WINDOW_TOKENS;
    }
    return undefined;
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
