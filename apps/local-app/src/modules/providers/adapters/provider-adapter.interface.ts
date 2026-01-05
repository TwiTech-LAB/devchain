/**
 * Provider Adapter Interface
 *
 * Defines the contract for provider-specific MCP command logic.
 * Each known provider (claude, codex, gemini) implements this interface
 * to encapsulate command building and output parsing.
 */

/**
 * Normalized MCP server entry returned by listMcpServers
 */
export interface McpServerEntry {
  alias: string;
  endpoint: string;
  transport?: string;
}

/**
 * Options for adding an MCP server
 */
export interface AddMcpServerOptions {
  endpoint: string;
  alias?: string;
  extraArgs?: string[];
}

/**
 * ProviderAdapter interface for known providers
 *
 * Centralizes provider-specific command logic and parsing
 * to decouple controllers, preflight, and CLI from provider details.
 */
export interface ProviderAdapter {
  /**
   * Provider name (e.g., 'claude', 'codex', 'gemini')
   */
  readonly providerName: string;

  /**
   * Build command arguments for adding an MCP server
   *
   * @param options - Configuration for MCP server registration
   * @returns Array of command arguments to pass to the provider binary
   */
  addMcpServer(options: AddMcpServerOptions): string[];

  /**
   * Build command arguments for listing registered MCP servers
   *
   * @returns Array of command arguments to pass to the provider binary
   */
  listMcpServers(): string[];

  /**
   * Build command arguments for removing an MCP server
   *
   * @param alias - The alias/name of the MCP server to remove
   * @returns Array of command arguments to pass to the provider binary
   */
  removeMcpServer(alias: string): string[];

  /**
   * Build command arguments for checking MCP connectivity
   *
   * @param alias - The alias/name of the MCP server to check
   * @returns Array of command arguments to pass to the provider binary
   */
  binaryCheck(alias: string): string[];

  /**
   * Parse the output of listMcpServers command and return normalized entries
   *
   * @param stdout - Standard output from the list command
   * @param stderr - Standard error from the list command (optional)
   * @returns Array of normalized MCP server entries
   */
  parseListOutput(stdout: string, stderr?: string): McpServerEntry[];
}
