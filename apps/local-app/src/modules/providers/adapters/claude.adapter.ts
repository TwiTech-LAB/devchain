import { ProviderAdapter, AddMcpServerOptions, McpServerEntry } from './provider-adapter.interface';

/**
 * Claude provider adapter
 *
 * Implements MCP command building and output parsing for the Claude CLI.
 */
export class ClaudeAdapter implements ProviderAdapter {
  readonly providerName = 'claude';

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
