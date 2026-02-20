import { Injectable } from '@nestjs/common';
import { ProviderAdapter, AddMcpServerOptions, McpServerEntry } from './provider-adapter.interface';

/**
 * Gemini provider adapter
 *
 * Implements MCP command building and output parsing for the Gemini CLI.
 */
@Injectable()
export class GeminiAdapter implements ProviderAdapter {
  readonly providerName = 'gemini';

  addMcpServer(options: AddMcpServerOptions): string[] {
    const alias = options.alias ?? 'devchain';
    // gemini mcp add -t http <alias> <endpoint>
    const args = ['mcp', 'add', '-t', 'http', alias, options.endpoint];
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

  binaryCheck(_alias: string): string[] {
    // Gemini has no separate check command, use list
    return ['mcp', 'list'];
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
      // Strip ANSI escape codes (color/formatting) that Gemini CLI may emit
      // even when spawned without a TTY
      const line = rawLine.replace(/\x1b\[[0-9;]*m/g, '');

      // Skip header lines (e.g., "Configured MCP servers:")
      if (line.toLowerCase().includes('configured mcp')) {
        continue;
      }

      // Parse format: "✓ alias: endpoint (transport) - status" or "✗ alias: ..."
      const match = line.match(/[✓✗]?\s*(\S+):\s+(\S+)\s+\(([^)]+)\)/);
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
