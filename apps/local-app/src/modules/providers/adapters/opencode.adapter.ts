import { Injectable } from '@nestjs/common';
import { ProviderAdapter, AddMcpServerOptions, McpServerEntry } from './provider-adapter.interface';

/**
 * OpenCode provider adapter
 *
 * Implements MCP command building and output parsing for the OpenCode CLI.
 * OpenCode manages MCP via project config file (opencode.json), not CLI commands.
 * CLI methods return safe fallback commands; actual MCP management is handled
 * by the registration service's config-file mode.
 */
@Injectable()
export class OpencodeAdapter implements ProviderAdapter {
  readonly providerName = 'opencode';
  readonly mcpMode = 'project_config' as const;
  readonly configFileName = 'opencode.json';

  addMcpServer(_options: AddMcpServerOptions): string[] {
    // OpenCode MCP is managed via opencode.json config file, not CLI.
    // Return version check as safe no-op fallback.
    return ['--version'];
  }

  listMcpServers(): string[] {
    return ['mcp', 'list'];
  }

  removeMcpServer(_alias: string): string[] {
    // OpenCode has no mcp remove command; managed via config file.
    return ['--version'];
  }

  binaryCheck(_alias: string): string[] {
    return ['--version'];
  }

  parseListOutput(_stdout: string, _stderr?: string): McpServerEntry[] {
    // OpenCode mcp list outputs TUI-formatted text with box-drawing chars.
    // Config-file mode reads opencode.json directly instead.
    return [];
  }

  /**
   * Parse MCP entries from opencode.json config file content.
   * Caller is responsible for handling JSON parse errors.
   */
  parseProjectConfig(content: string): McpServerEntry[] {
    const config = JSON.parse(content);
    const mcp = config?.mcp;
    if (!mcp || typeof mcp !== 'object') return [];

    const entries: McpServerEntry[] = [];
    for (const [alias, serverConfig] of Object.entries(mcp)) {
      const cfg = serverConfig as Record<string, unknown>;
      if (cfg?.url && typeof cfg.url === 'string') {
        entries.push({
          alias,
          endpoint: cfg.url,
          transport: typeof cfg.type === 'string' ? cfg.type.toUpperCase() : 'REMOTE',
        });
      }
    }
    return entries;
  }

  /**
   * Build the MCP config entry to write into opencode.json.
   */
  buildMcpConfigEntry(options: AddMcpServerOptions): {
    key: string;
    value: Record<string, unknown>;
  } {
    return {
      key: options.alias ?? 'devchain',
      value: {
        type: 'remote',
        url: options.endpoint,
      },
    };
  }
}
