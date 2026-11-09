import { Injectable } from '@nestjs/common';
import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import * as path from 'path';
import type { Provider } from '../../../storage/models/domain.models';
import { createLogger } from '../../../../common/logging/logger';
import { ProviderAdapterFactory } from '../../adapters/provider-adapter.factory';
import { isConfigFileMcpCapable } from '../../adapters/capabilities';
import type { ConfigFileMcpCapability } from '../../adapters/capabilities';
import { addToGitExclude } from '../../../../common/git-exclude';
import { parseJsonc, setJsoncValue } from '../../../../common/jsonc';
import { ProcessExecutor } from '../../../terminal/services/process-executor/process-executor.port';
import type {
  McpRegistrationAdapter,
  McpCommandResult,
  McpListResult,
  McpExecOptions,
  McpRegisterOptions,
  EnsureRegistrationResult,
} from './mcp-registration.types';

const logger = createLogger('ConfigFileMcpRegistrationAdapter');

@Injectable()
export class ConfigFileMcpRegistrationAdapter implements McpRegistrationAdapter {
  constructor(
    private readonly adapterFactory: ProviderAdapterFactory,
    private readonly executor: ProcessExecutor,
  ) {}

  async register(
    provider: Provider,
    options: McpRegisterOptions,
    execOptions?: McpExecOptions,
  ): Promise<McpCommandResult> {
    const cwd = execOptions?.cwd;
    if (!cwd) {
      return {
        success: false,
        message: `Provider ${provider.name} requires a project path (cwd) for config-file MCP management`,
        stdout: '',
        stderr: '',
        exitCode: null,
      };
    }

    const provAdapter = this.adapterFactory.getAdapter(provider.name);
    if (!isConfigFileMcpCapable(provAdapter)) {
      return {
        success: false,
        message: `Provider ${provider.name} does not support config-file MCP management`,
        stdout: '',
        stderr: '',
        exitCode: null,
      };
    }

    const configPath = path.join(cwd, provAdapter.configFileName);
    let config: Record<string, unknown> = {};
    let content: string | null = null;

    try {
      content = await readFile(configPath, 'utf-8');
      const parsed = parseConfigText(provAdapter, content);
      if (!isPlainRecord(parsed)) {
        return {
          success: false,
          message: `${provAdapter.configFileName} has invalid root structure (expected JSON object) — please fix it manually`,
          stdout: '',
          stderr: '',
          exitCode: null,
        };
      }
      config = parsed;
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        return {
          success: false,
          message: `${provAdapter.configFileName} is malformed JSON — please fix it manually before registering MCP`,
          stdout: '',
          stderr: '',
          exitCode: null,
        };
      }
      if (isNodeError(error) && error.code === 'ENOENT') {
        config = {};
      } else {
        throw error;
      }
    }

    const rootKey = serverMapKey(provAdapter);
    const entry = provAdapter.buildMcpConfigEntry(options);
    if (config[rootKey] !== undefined && !isPlainRecord(config[rootKey])) {
      return invalidServerMapResult(provAdapter, rootKey);
    }
    let output: string;
    if (provAdapter.configFileAllowsComments) {
      output = setJsoncValue(content ?? '{}\n', [rootKey, entry.key], entry.value);
    } else {
      const servers = (config[rootKey] as Record<string, unknown>) ?? {};
      servers[entry.key] = entry.value;
      config[rootKey] = servers;
      output = JSON.stringify(config, null, 2) + '\n';
    }
    await this.writeConfigFile(provAdapter, cwd, configPath, output);

    return {
      success: true,
      message: `MCP entry '${entry.key}' written to ${provAdapter.configFileName}`,
      stdout: '',
      stderr: '',
      exitCode: 0,
    };
  }

  async list(provider: Provider, execOptions?: McpExecOptions): Promise<McpListResult> {
    const cwd = execOptions?.cwd;
    if (!cwd) {
      return {
        success: false,
        message: `Provider ${provider.name} requires a project path (cwd) for config-file MCP management`,
        entries: [],
      };
    }

    const provAdapter = this.adapterFactory.getAdapter(provider.name);
    if (!isConfigFileMcpCapable(provAdapter)) {
      return {
        success: false,
        message: `Provider ${provider.name} does not support config-file MCP management`,
        entries: [],
      };
    }

    const configPath = path.join(cwd, provAdapter.configFileName);

    try {
      const content = await readFile(configPath, 'utf-8');
      const entries = provAdapter.parseProjectConfig(content);
      return {
        success: true,
        message: `Read ${entries.length} MCP entry(ies) from ${provAdapter.configFileName}`,
        entries,
      };
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        return {
          success: false,
          message: `${provAdapter.configFileName} is malformed JSON — please fix it manually`,
          entries: [],
        };
      }
      if (isNodeError(error) && error.code === 'ENOENT') {
        return {
          success: true,
          message: `${provAdapter.configFileName} not found — no MCP entries configured`,
          entries: [],
        };
      }
      throw error;
    }
  }

  async remove(
    provider: Provider,
    alias: string,
    execOptions?: McpExecOptions,
  ): Promise<McpCommandResult> {
    const cwd = execOptions?.cwd;
    if (!cwd) {
      return {
        success: false,
        message: `Provider ${provider.name} requires a project path (cwd) for config-file MCP management`,
        stdout: '',
        stderr: '',
        exitCode: null,
      };
    }

    const provAdapter = this.adapterFactory.getAdapter(provider.name);
    if (!isConfigFileMcpCapable(provAdapter)) {
      return {
        success: false,
        message: `Provider ${provider.name} does not support config-file MCP management`,
        stdout: '',
        stderr: '',
        exitCode: null,
      };
    }

    const configPath = path.join(cwd, provAdapter.configFileName);
    let config: Record<string, unknown>;
    let content: string;

    try {
      content = await readFile(configPath, 'utf-8');
      const parsed = parseConfigText(provAdapter, content);
      if (!isPlainRecord(parsed)) {
        return {
          success: false,
          message: `${provAdapter.configFileName} has invalid root structure (expected JSON object) — please fix it manually`,
          stdout: '',
          stderr: '',
          exitCode: null,
        };
      }
      config = parsed;
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        return {
          success: false,
          message: `${provAdapter.configFileName} is malformed JSON — please fix it manually`,
          stdout: '',
          stderr: '',
          exitCode: null,
        };
      }
      if (isNodeError(error) && error.code === 'ENOENT') {
        return {
          success: true,
          message: `${provAdapter.configFileName} not found — nothing to remove`,
          stdout: '',
          stderr: '',
          exitCode: 0,
        };
      }
      throw error;
    }

    const rootKey = serverMapKey(provAdapter);
    if (config[rootKey] !== undefined && !isPlainRecord(config[rootKey])) {
      return invalidServerMapResult(provAdapter, rootKey);
    }
    const servers = config[rootKey] as Record<string, unknown> | undefined;
    if (!servers || !(alias in servers)) {
      return {
        success: true,
        message: `MCP entry '${alias}' not found in ${provAdapter.configFileName}`,
        stdout: '',
        stderr: '',
        exitCode: 0,
      };
    }

    let output: string;
    if (provAdapter.configFileAllowsComments) {
      output = setJsoncValue(content, [rootKey, alias], undefined);
    } else {
      delete servers[alias];
      output = JSON.stringify(config, null, 2) + '\n';
    }
    await this.writeConfigFile(provAdapter, cwd, configPath, output);

    return {
      success: true,
      message: `MCP entry '${alias}' removed from ${provAdapter.configFileName}`,
      stdout: '',
      stderr: '',
      exitCode: 0,
    };
  }

  /** Atomic write (temp file + rename), then the git exclude when the adapter asks for it. */
  private async writeConfigFile(
    provAdapter: ConfigFileMcpCapability,
    cwd: string,
    configPath: string,
    output: string,
  ): Promise<void> {
    const tmpPath = configPath + '.tmp';
    // The config may live in a subdirectory that does not exist yet on fresh
    // projects (devin's `<cwd>/.devin/`); create it before the atomic write.
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(tmpPath, output, 'utf-8');
    await rename(tmpPath, configPath);
    await this.excludeFromGit(provAdapter, cwd);
  }

  /**
   * Keep a machine-local config file out of git after DevChain wrote it. The
   * file is already written, so a failure here only logs a warning.
   */
  private async excludeFromGit(provAdapter: ConfigFileMcpCapability, cwd: string): Promise<void> {
    if (!provAdapter.excludeConfigFileFromGit) return;
    try {
      await addToGitExclude(this.executor, cwd, [provAdapter.configFileName]);
    } catch (error) {
      logger.warn(
        { error, cwd, configFileName: provAdapter.configFileName },
        'Failed to add the MCP config file to the git exclude file',
      );
    }
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
        'MCP config endpoint mismatch, updating',
      );

      const addResult = await this.register(
        provider,
        { endpoint: options.endpoint, alias: options.alias },
        execOptions,
      );
      if (!addResult.success) {
        return {
          success: false,
          action: 'error',
          message: `Failed to update MCP config: ${addResult.message}`,
        };
      }

      return {
        success: true,
        action: 'fixed_mismatch',
        endpoint: options.endpoint,
        alias: options.alias,
      };
    }

    logger.info({ provider: provider.name }, 'MCP not configured, adding');
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
}

/**
 * Key of the server map in the config file. Providers may nest the map under a
 * non-'mcp' root key (devin: 'mcpServers'); the default stays 'mcp'
 * (opencode-flat shape).
 */
function serverMapKey(adapter: ConfigFileMcpCapability): string {
  return adapter.mcpConfigRootKey ?? 'mcp';
}

function invalidServerMapResult(
  adapter: ConfigFileMcpCapability,
  rootKey: string,
): McpCommandResult {
  return {
    success: false,
    message: `${adapter.configFileName} has invalid "${rootKey}" field (expected object) — please fix it manually`,
    stdout: '',
    stderr: '',
    exitCode: null,
  };
}

/** Parse config text; throws `SyntaxError` on invalid content. */
function parseConfigText(adapter: ConfigFileMcpCapability, content: string): unknown {
  return adapter.configFileAllowsComments ? parseJsonc(content) : JSON.parse(content);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
