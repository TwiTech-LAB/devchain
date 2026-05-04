import { Injectable } from '@nestjs/common';
import {
  ProviderAdapter,
  AddMcpServerOptions,
  McpServerEntry,
  LaunchInitialPromptBehavior,
  BuildLaunchArgsInput,
} from './provider-adapter.interface';

/**
 * Gemini provider adapter
 *
 * Implements MCP command building and output parsing for the Gemini CLI.
 */
@Injectable()
export class GeminiAdapter implements ProviderAdapter {
  readonly providerName = 'gemini';
  readonly mcpListSpawnMode = 'pty' as const;
  readonly mcpProjectRegistrationStrategy = 'upsert' as const;
  // Verification (2026-05-03): `gemini mcp add` and `gemini mcp remove` are
  // pipe-safe — they exit 0/non-zero reliably even with empty stdout/stderr.
  // Only `mcp list` requires PTY (see mcpListSpawnMode).
  readonly launchInitialPromptBehavior: LaunchInitialPromptBehavior = {
    preKeys: ['Enter'],
    preDelayMs: 5000,
  };

  addMcpServer(options: AddMcpServerOptions): string[] {
    const alias = options.alias ?? 'devchain';
    // gemini mcp add --scope project -t http <alias> <endpoint>
    const args = ['mcp', 'add', '--scope', 'project', '-t', 'http', alias, options.endpoint];
    if (options.extraArgs?.length) {
      args.push(...options.extraArgs);
    }
    return args;
  }

  listMcpServers(): string[] {
    return ['mcp', 'list'];
  }

  removeMcpServer(alias: string): string[] {
    return ['mcp', 'remove', '--scope', 'project', alias];
  }

  binaryCheck(_alias: string): string[] {
    // Gemini has no separate check command, use list
    return ['mcp', 'list'];
  }

  buildLaunchArgs({ mode, providerSessionId, profileOptionArgs }: BuildLaunchArgsInput): {
    argv: string[];
  } {
    if (mode === 'restore') {
      return { argv: ['--resume', providerSessionId!, ...profileOptionArgs] };
    }
    return { argv: [...profileOptionArgs] };
  }

  parseListOutput(stdout: string, stderr?: string): McpServerEntry[] {
    // Gemini CLI outputs MCP list to stderr, not stdout.
    // Use stderr as fallback when stdout is empty.
    const output = stdout.trim() ? stdout : (stderr ?? '');

    // Gemini CLI output format:
    // Configured MCP servers:
    //
    // ✓ devchain: http://127.0.0.1:3000/mcp (sse) - Connected
    // ✗ server2: http://127.0.0.1:4000/mcp (sse) - Failed
    const entries: McpServerEntry[] = [];
    const lines = output.split('\n').filter((line) => line.trim().length > 0);

    for (const rawLine of lines) {
      const line = rawLine
        .replace(/\x1b\[[\d;?]*[A-Za-z]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\r/g, '');

      // Skip header lines (e.g., "Configured MCP servers:")
      if (line.toLowerCase().includes('configured mcp')) {
        continue;
      }

      // Parse format: "✓ alias: endpoint (transport) - status" or "✗ alias: ..."
      // Transport group is optional — Gemini CLI may omit it on some versions.
      const match = line.match(/[✓✗]?\s*(\S+):\s+(\S+)(?:\s+\(([^)]+)\))?/);
      if (match) {
        const [, alias, endpoint, transport] = match;
        entries.push({
          alias,
          endpoint,
          transport: transport ? transport.toUpperCase() : undefined,
        });
      }
    }

    return entries;
  }
}
