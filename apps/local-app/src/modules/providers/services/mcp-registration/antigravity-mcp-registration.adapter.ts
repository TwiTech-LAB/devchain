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

/** Names no value: the home comes from the session environment. */
const RELATIVE_HOME_MESSAGE =
  'HOME in the session environment must be an absolute path: agy refuses an empty or relative HOME';

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

  /**
   * agy's HOME-global MCP config file (cwd-independent), under the `HOME` agy runs with. `label`
   * names it in messages: a home from the session environment shows as `$HOME`. The service home
   * applies only when the session environment omits `HOME`. Null when the session sets a `HOME`
   * that is not absolute, the empty string included: agy refuses it, and the file would land in
   * DevChain's working directory or in the service account.
   */
  private configFile(execOptions?: McpExecOptions): ConfigFile | null {
    const relative = path.join('.gemini', 'config', 'mcp_config.json');
    const envHome = execOptions?.env?.HOME;
    if (envHome !== undefined) {
      if (!path.isAbsolute(envHome)) return null;
      return { path: path.join(envHome, relative), label: path.join('$HOME', relative), envHome };
    }
    const configPath = path.join(homedir(), relative);
    return { path: configPath, label: configPath };
  }

  async register(
    provider: Provider,
    options: McpRegisterOptions,
    execOptions?: McpExecOptions,
  ): Promise<McpCommandResult> {
    const provAdapter = this.adapterFactory.getAdapter(provider.name);
    if (!isGlobalMcpConfigCapable(provAdapter)) {
      return commandFailure(unsupportedMessage(provider));
    }

    const read = await this.readConfig(execOptions);
    if (!read.ok) return commandFailure(read.message);
    const { file, config } = read;

    if (config.mcpServers !== undefined && !isPlainRecord(config.mcpServers)) {
      return commandFailure(invalidServersMessage(file));
    }

    const entry = provAdapter.buildGlobalMcpServerEntry(options);
    const mcpServers = (config.mcpServers as Record<string, unknown>) ?? {};
    mcpServers[entry.key] = entry.value;
    config.mcpServers = mcpServers;

    await this.writeConfig(file, config);

    return {
      success: true,
      message: `MCP server '${entry.key}' written to ${file.label}`,
      stdout: '',
      stderr: '',
      exitCode: 0,
    };
  }

  async list(provider: Provider, execOptions?: McpExecOptions): Promise<McpListResult> {
    const provAdapter = this.adapterFactory.getAdapter(provider.name);
    if (!isGlobalMcpConfigCapable(provAdapter)) {
      return { success: false, message: unsupportedMessage(provider), entries: [] };
    }

    const read = await this.readConfig(execOptions);
    if (!read.ok) {
      return { success: false, message: read.message, entries: [] };
    }
    // An empty/absent config means "no servers configured" — re-serialize the
    // normalized object so the capability parses a consistent shape.
    const entries = provAdapter.parseGlobalMcpConfig(JSON.stringify(read.config));
    return {
      success: true,
      message: `Read ${entries.length} MCP entry(ies) from ${read.file.label}`,
      entries,
    };
  }

  async remove(
    provider: Provider,
    alias: string,
    execOptions?: McpExecOptions,
  ): Promise<McpCommandResult> {
    const provAdapter = this.adapterFactory.getAdapter(provider.name);
    if (!isGlobalMcpConfigCapable(provAdapter)) {
      return commandFailure(unsupportedMessage(provider));
    }

    const read = await this.readConfig(execOptions);
    if (!read.ok) return commandFailure(read.message);
    const { file, config } = read;

    if (config.mcpServers !== undefined && !isPlainRecord(config.mcpServers)) {
      return commandFailure(invalidServersMessage(file));
    }
    const mcpServers = config.mcpServers as Record<string, unknown> | undefined;
    if (!mcpServers || !(alias in mcpServers)) {
      return {
        success: true,
        message: `MCP server '${alias}' not found in ${file.label}`,
        stdout: '',
        stderr: '',
        exitCode: 0,
      };
    }

    delete mcpServers[alias];
    config.mcpServers = mcpServers;
    await this.writeConfig(file, config);

    return {
      success: true,
      message: `MCP server '${alias}' removed from ${file.label}`,
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

      // A config read in a session environment can name that environment's paths or keys.
      const quiet = execOptions?.env !== undefined;
      logger.info(
        {
          provider: provider.name,
          ...(quiet ? {} : { existing: existing.endpoint }),
          expected: options.endpoint,
        },
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
   * Resolve, read + parse the global config. A missing OR empty file (agy ships a 0-byte
   * `mcp_config.json` on install) is the valid "no servers yet" state → `{}`.
   * Genuinely malformed JSON is refused (no silent data loss), and so is a session HOME that is
   * not absolute, before any file access.
   */
  private async readConfig(
    execOptions?: McpExecOptions,
  ): Promise<
    { ok: true; file: ConfigFile; config: Record<string, unknown> } | { ok: false; message: string }
  > {
    const file = this.configFile(execOptions);
    if (!file) return { ok: false, message: RELATIVE_HOME_MESSAGE };
    const { label } = file;
    let content: string;
    try {
      content = await readFile(file.path, 'utf-8');
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return { ok: true, file, config: {} };
      }
      throw hideEnvHome(error, file);
    }

    if (content.trim() === '') {
      return { ok: true, file, config: {} };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return {
        ok: false,
        message: `${label} is malformed JSON — please fix it manually before registering MCP`,
      };
    }
    if (!isPlainRecord(parsed)) {
      return {
        ok: false,
        message: `${label} has invalid root structure (expected JSON object) — please fix it manually`,
      };
    }
    return { ok: true, file, config: parsed };
  }

  /** Atomic write (tmp + rename), creating the parent dir if needed. */
  private async writeConfig(file: ConfigFile, config: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(path.dirname(file.path), { recursive: true });
      const tmpPath = file.path + '.tmp';
      await writeFile(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
      await rename(tmpPath, file.path);
    } catch (error: unknown) {
      throw hideEnvHome(error, file);
    }
  }
}

interface ConfigFile {
  path: string;
  label: string;
  /** Set when the home comes from the session environment, which must not reach a message. */
  envHome?: string;
}

function commandFailure(message: string): McpCommandResult {
  return { success: false, message, stdout: '', stderr: '', exitCode: null };
}

function unsupportedMessage(provider: Provider): string {
  return `Provider ${provider.name} does not support global-config MCP management`;
}

function invalidServersMessage(file: ConfigFile): string {
  return `${file.label} has invalid "mcpServers" field (expected object) — please fix it manually`;
}

/** An fs error names the path it failed on; a home from the session environment shows as `$HOME`. */
function hideEnvHome(error: unknown, file: ConfigFile): unknown {
  if (!file.envHome || !(error instanceof Error)) return error;
  const hidden = new Error(error.message.split(file.envHome).join('$HOME'));
  if (isNodeError(error)) Object.assign(hidden, { code: error.code });
  return hidden;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  // Duck-typed (not `instanceof Error`) so it stays correct for native fs errors,
  // which can cross jest's module-realm boundary and fail an `instanceof` check.
  return typeof error === 'object' && error !== null && 'code' in error;
}
