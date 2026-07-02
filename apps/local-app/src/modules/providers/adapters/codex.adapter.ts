import { Injectable } from '@nestjs/common';
import type {
  ProviderAdapter,
  AddMcpServerOptions,
  McpServerEntry,
  LaunchInitialPromptBehavior,
  BuildLaunchArgsInput,
} from './provider-adapter.interface';
import type { McpCliCapability, TranscriptDiscoveryCapability } from './capabilities';

@Injectable()
export class CodexAdapter
  implements ProviderAdapter, McpCliCapability, TranscriptDiscoveryCapability
{
  readonly providerName = 'codex';
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
