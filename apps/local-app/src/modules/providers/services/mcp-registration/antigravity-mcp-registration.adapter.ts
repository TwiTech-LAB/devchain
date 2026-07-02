import { Injectable } from '@nestjs/common';
import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { homedir } from 'os';
import * as path from 'path';
import type { Provider } from '../../../storage/models/domain.models';
import { createLogger } from '../../../../common/logging/logger';
import { ProviderAdapterFactory } from '../../adapters/provider-adapter.factory';
import { isGlobalMcpConfigCapable } from '../../adapters/capabilities';
import type {
  McpRegistrationAdapter,
  McpCommandResult,
  McpListResult,
  McpExecOptions,
  McpRegisterOptions,
  EnsureRegistrationResult,
} from './mcp-registration.types';

const logger = createLogger('AntigravityMcpRegistrationAdapter');

/**
 * MCP registration adapter for Antigravity (`agy`) — the third concrete adapter
 * under `McpRegistrationPort` (alongside CLI + project-local ConfigFile).
 *
 * Unlike the project-local `ConfigFileMcpRegistrationAdapter` (which joins
 * `configFileName` with the project `cwd`), agy's MCP servers live in a single
 * HOME-global file `~/.gemini/config/mcp_config.json` (strace-proven for v1.0.12;
 * project-local `.agents/mcp_config.json` is read-but-ignored upstream). The root
 * key is `mcpServers` (gemini/windsurf-style), not opencode's flat `mcp`, and the
 * remote transport field is `serverUrl`. `cwd` is therefore ignored here.
 *
 * The schema specifics (parse + per-server entry) are delegated to the agy
 * adapter's `GlobalMcpConfigCapability`; this adapter owns the file path, the
 * `mcpServers` merge, empty/malformed-file handling, and atomic writes.
 */
@Injectable()
export class AntigravityMcpRegistrationAdapter implements McpRegistrationAdapter {
  constructor(private readonly adapterFactory: ProviderAdapterFactory) {}

  /** Resolve agy's HOME-global MCP config path (cwd-independent). */
  private configPath(): string {
    return path.join(homedir(), '.gemini', 'config', 'mcp_config.json');
  }

  async register(
    provider: Provider,
    options: McpRegisterOptions,
    _execOptions?: McpExecOptions,
  ): Promise<McpCommandResult> {
    const provAdapter = this.adapterFactory.getAdapter(provider.name);
    if (!isGlobalMcpConfigCapable(provAdapter)) {
      return {
        success: false,
        message: `Provider ${provider.name} does not support global-config MCP management`,
        stdout: '',
        stderr: '',
        exitCode: null,
      };
    }

    const configPath = this.configPath();
    const read = await this.readConfig(configPath);
    if (!read.ok) {
      return { success: false, message: read.message, stdout: '', stderr: '', exitCode: null };
    }
    const config = read.config;

    if (config.mcpServers !== undefined && !isPlainRecord(config.mcpServers)) {
      return {
        success: false,
        message: `${configPath} has invalid "mcpServers" field (expected object) — please fix it manually`,
        stdout: '',
        stderr: '',
        exitCode: null,
      };
    }

    const entry = provAdapter.buildGlobalMcpServerEntry(options);
    const mcpServers = (config.mcpServers as Record<string, unknown>) ?? {};
    mcpServers[entry.key] = entry.value;
    config.mcpServers = mcpServers;

    await this.writeConfig(configPath, config);

    return {
      success: true,
      message: `MCP server '${entry.key}' written to ${configPath}`,
      stdout: '',
      stderr: '',
      exitCode: 0,
    };
  }

  async list(provider: Provider, _execOptions?: McpExecOptions): Promise<McpListResult> {
    const provAdapter = this.adapterFactory.getAdapter(provider.name);
    if (!isGlobalMcpConfigCapable(provAdapter)) {
      return {
        success: false,
        message: `Provider ${provider.name} does not support global-config MCP management`,
        entries: [],
      };
    }

    const configPath = this.configPath();
    const read = await this.readConfig(configPath);
    if (!read.ok) {
      return { success: false, message: read.message, entries: [] };
    }
    // An empty/absent config means "no servers configured" — re-serialize the
    // normalized object so the capability parses a consistent shape.
    const entries = provAdapter.parseGlobalMcpConfig(JSON.stringify(read.config));
    return {
      success: true,
      message: `Read ${entries.length} MCP entry(ies) from ${configPath}`,
      entries,
    };
  }

  async remove(
    provider: Provider,
    alias: string,
    _execOptions?: McpExecOptions,
  ): Promise<McpCommandResult> {
    const provAdapter = this.adapterFactory.getAdapter(provider.name);
    if (!isGlobalMcpConfigCapable(provAdapter)) {
      return {
        success: false,
        message: `Provider ${provider.name} does not support global-config MCP management`,
        stdout: '',
        stderr: '',
        exitCode: null,
      };
    }

    const configPath = this.configPath();
    const read = await this.readConfig(configPath);
    if (!read.ok) {
      return { success: false, message: read.message, stdout: '', stderr: '', exitCode: null };
    }
    const config = read.config;

    if (config.mcpServers !== undefined && !isPlainRecord(config.mcpServers)) {
      return {
        success: false,
        message: `${configPath} has invalid "mcpServers" field (expected object) — please fix it manually`,
        stdout: '',
        stderr: '',
        exitCode: null,
      };
    }
    const mcpServers = config.mcpServers as Record<string, unknown> | undefined;
    if (!mcpServers || !(alias in mcpServers)) {
      return {
        success: true,
        message: `MCP server '${alias}' not found in ${configPath}`,
        stdout: '',
        stderr: '',
        exitCode: 0,
      };
    }

    delete mcpServers[alias];
    config.mcpServers = mcpServers;
    await this.writeConfig(configPath, config);

    return {
      success: true,
      message: `MCP server '${alias}' removed from ${configPath}`,
      stdout: '',
      stderr: '',
      exitCode: 0,
    };
  }

  async ensure(
    provider: Provider,
    options: { endpoint: string; alias: string },
    execOptions?: McpExecOptions,
  ): Promise<EnsureRegistrationResult> {
    const listResult = await this.list(provider, execOptions);

    if (!listResult.success) {
      return {
        success: false,
        action: 'error',
        message: `Failed to list MCP registrations: ${listResult.message}`,
      };
    }

    const existing = listResult.entries.find((e) => e.alias === options.alias);

    if (existing) {
      if (existing.endpoint === options.endpoint) {
        return { success: true, action: 'already_configured' };
      }

      logger.info(
        { provider: provider.name, existing: existing.endpoint, expected: options.endpoint },
        'agy MCP config endpoint mismatch, updating',
      );

      const fixResult = await this.register(
        provider,
        { endpoint: options.endpoint, alias: options.alias },
        execOptions,
      );
      if (!fixResult.success) {
        return {
          success: false,
          action: 'error',
          message: `Failed to update MCP config: ${fixResult.message}`,
        };
      }

      return {
        success: true,
        action: 'fixed_mismatch',
        endpoint: options.endpoint,
        alias: options.alias,
      };
    }

    logger.info({ provider: provider.name }, 'agy MCP not configured, adding');
    const addResult = await this.register(
      provider,
      { endpoint: options.endpoint, alias: options.alias },
      execOptions,
    );
    if (!addResult.success) {
      return {
        success: false,
        action: 'error',
        message: `Failed to register MCP: ${addResult.message}`,
      };
    }

    return {
      success: true,
      action: 'added',
      endpoint: options.endpoint,
      alias: options.alias,
    };
  }

  /**
   * Read + parse the global config. A missing OR empty file (agy ships a 0-byte
   * `mcp_config.json` on install) is the valid "no servers yet" state → `{}`.
   * Genuinely malformed JSON is refused (no silent data loss).
   */
  private async readConfig(
    configPath: string,
  ): Promise<{ ok: true; config: Record<string, unknown> } | { ok: false; message: string }> {
    let content: string;
    try {
      content = await readFile(configPath, 'utf-8');
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return { ok: true, config: {} };
      }
      throw error;
    }

    if (content.trim() === '') {
      return { ok: true, config: {} };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return {
        ok: false,
        message: `${configPath} is malformed JSON — please fix it manually before registering MCP`,
      };
    }
    if (!isPlainRecord(parsed)) {
      return {
        ok: false,
        message: `${configPath} has invalid root structure (expected JSON object) — please fix it manually`,
      };
    }
    return { ok: true, config: parsed };
  }

  /** Atomic write (tmp + rename), creating the parent dir if needed. */
  private async writeConfig(configPath: string, config: Record<string, unknown>): Promise<void> {
    await mkdir(path.dirname(configPath), { recursive: true });
    const tmpPath = configPath + '.tmp';
    await writeFile(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    await rename(tmpPath, configPath);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  // Duck-typed (not `instanceof Error`) so it stays correct for native fs errors,
  // which can cross jest's module-realm boundary and fail an `instanceof` check.
  return typeof error === 'object' && error !== null && 'code' in error;
}
