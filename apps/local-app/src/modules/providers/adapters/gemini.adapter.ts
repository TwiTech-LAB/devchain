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
    // gemini mcp add <alias> <endpoint> --type http
    const args = ['mcp', 'add', alias, options.endpoint, '--type', 'http'];
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

  parseListOutput(stdout: string, _stderr?: string): McpServerEntry[] {
    // Gemini CLI output format:
    // Configured MCP servers:
    //
    // ✓ devchain: http://127.0.0.1:3000/mcp (sse) - Connected
    // ✗ server2: http://127.0.0.1:4000/mcp (sse) - Failed
    const entries: McpServerEntry[] = [];
    const lines = stdout.split('\n').filter((line) => line.trim().length > 0);

    for (const line of lines) {
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
