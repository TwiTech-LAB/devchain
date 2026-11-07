import { Injectable } from '@nestjs/common';
import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import * as path from 'path';
import type { Provider } from '../../../storage/models/domain.models';
import { createLogger } from '../../../../common/logging/logger';
import { ProviderAdapterFactory } from '../../adapters/provider-adapter.factory';
import { isConfigFileMcpCapable } from '../../adapters/capabilities';
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
  constructor(private readonly adapterFactory: ProviderAdapterFactory) {}

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

    try {
      const content = await readFile(configPath, 'utf-8');
      const parsed = JSON.parse(content);
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

    // Providers may nest the server map under a non-'mcp' root key
    // (devin: 'mcpServers'); default stays 'mcp' (opencode-flat shape).
    const rootKey = provAdapter.mcpConfigRootKey ?? 'mcp';
    const entry = provAdapter.buildMcpConfigEntry(options);
    if (config[rootKey] !== undefined && !isPlainRecord(config[rootKey])) {
      return {
        success: false,
        message: `${provAdapter.configFileName} has invalid "${rootKey}" field (expected object) — please fix it manually`,
        stdout: '',
        stderr: '',
        exitCode: null,
      };
    }
    const mcp = (config[rootKey] as Record<string, unknown>) ?? {};
    mcp[entry.key] = entry.value;
    config[rootKey] = mcp;

    const tmpPath = configPath + '.tmp';
    // The config may live in a subdirectory that does not exist yet on fresh
    // projects (devin's `<cwd>/.devin/`); create it before the atomic write.
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    await rename(tmpPath, configPath);

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

    try {
      const content = await readFile(configPath, 'utf-8');
      const parsed = JSON.parse(content);
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

    const rootKey = provAdapter.mcpConfigRootKey ?? 'mcp';
    if (config[rootKey] !== undefined && !isPlainRecord(config[rootKey])) {
      return {
        success: false,
        message: `${provAdapter.configFileName} has invalid "${rootKey}" field (expected object) — please fix it manually`,
        stdout: '',
        stderr: '',
        exitCode: null,
      };
    }
    const mcp = config[rootKey] as Record<string, unknown> | undefined;
    if (!mcp || !(alias in mcp)) {
      return {
        success: true,
        message: `MCP entry '${alias}' not found in ${provAdapter.configFileName}`,
        stdout: '',
        stderr: '',
        exitCode: 0,
      };
    }

    delete mcp[alias];
    config[rootKey] = mcp;

    const tmpPath = configPath + '.tmp';
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    await rename(tmpPath, configPath);

    return {
      success: true,
      message: `MCP entry '${alias}' removed from ${provAdapter.configFileName}`,
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
