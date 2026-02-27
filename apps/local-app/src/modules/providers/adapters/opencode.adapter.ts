import { Injectable } from '@nestjs/common';
import { ProviderAdapter, AddMcpServerOptions, McpServerEntry } from './provider-adapter.interface';

/**
 * OpenCode provider adapter (z.ai coding plan)
 *
 * Implements MCP command building and output parsing for the OpenCode CLI.
 * Uses Claude-compatible MCP command structure.
 */
@Injectable()
export class OpencodeAdapter implements ProviderAdapter {
  readonly providerName = 'opencode';

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
    const entries: McpServerEntry[] = [];
    const lines = stdout.split('\n').filter((line) => line.trim().length > 0);

    for (const line of lines) {
      if (line.toLowerCase().startsWith('checking')) {
        continue;
      }

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
