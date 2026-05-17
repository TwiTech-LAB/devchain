import { Injectable } from '@nestjs/common';
import * as path from 'path';
import type { Provider } from '../../../storage/models/domain.models';
import { createLogger } from '../../../../common/logging/logger';
import { resolveBinary } from '../../../../common/resolve-binary';
import {
  ProviderAdapterFactory,
  type ProviderAdapter,
  type McpCliCapability,
} from '../../adapters';
import { ProcessExecutor } from '../../../terminal/services/process-executor/process-executor.port';
import type {
  McpRegistrationAdapter,
  McpCommandResult,
  McpListResult,
  McpExecOptions,
  McpRegisterOptions,
  EnsureRegistrationResult,
} from './mcp-registration.types';

const logger = createLogger('CliMcpRegistrationAdapter');

export interface McpBinaryResolution {
  success: boolean;
  message?: string;
  binaryPath?: string;
  source?: 'configured' | 'which';
}

@Injectable()
export class CliMcpRegistrationAdapter implements McpRegistrationAdapter {
  constructor(
    private readonly adapterFactory: ProviderAdapterFactory,
    private readonly executor: ProcessExecutor,
  ) {}

  async register(
    provider: Provider,
    options: McpRegisterOptions,
    execOptions?: McpExecOptions,
  ): Promise<McpCommandResult> {
    const resolution = await this.resolveBinary(provider);
    if (!resolution.success || !resolution.binaryPath) {
      return {
        success: false,
        message: resolution.message ?? 'Unable to resolve provider binary',
        stdout: '',
        stderr: '',
        exitCode: null,
      };
    }

    const cliAdapter = this.getCliAdapter(provider);
    const args = cliAdapter.addMcpServer({
      endpoint: options.endpoint,
      alias: options.alias,
      extraArgs: options.extraArgs,
    });
    return this.execute(resolution.binaryPath, args, 'pipe', execOptions);
  }

  async list(provider: Provider, execOptions?: McpExecOptions): Promise<McpListResult> {
    const resolution = await this.resolveBinary(provider);
    if (!resolution.success || !resolution.binaryPath) {
      return {
        success: false,
        message: resolution.message ?? 'Unable to resolve provider binary',
        entries: [],
        binaryPath: undefined,
        stdout: '',
        stderr: '',
      };
    }

    const cliAdapter = this.getCliAdapter(provider);
    const args = cliAdapter.listMcpServers();
    const mode = cliAdapter.mcpListSpawnMode === 'pty' ? 'pty' : 'pipe';
    const result = await this.execute(resolution.binaryPath, args, mode, execOptions);

    if (!result.success) {
      return {
        success: false,
        message: result.message,
        entries: [],
        binaryPath: result.binaryPath,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }

    const entries = cliAdapter.parseListOutput(result.stdout, result.stderr);
    return {
      success: true,
      message: result.message,
      entries,
      binaryPath: result.binaryPath,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async remove(
    provider: Provider,
    alias: string,
    execOptions?: McpExecOptions,
  ): Promise<McpCommandResult> {
    const resolution = await this.resolveBinary(provider);
    if (!resolution.success || !resolution.binaryPath) {
      return {
        success: false,
        message: resolution.message ?? 'Unable to resolve provider binary',
        stdout: '',
        stderr: '',
        exitCode: null,
      };
    }

    const cliAdapter = this.getCliAdapter(provider);
    const args = cliAdapter.removeMcpServer(alias);
    return this.execute(resolution.binaryPath, args, 'pipe', {
      timeoutMs: execOptions?.timeoutMs ?? 10_000,
      cwd: execOptions?.cwd,
    });
  }

  async ensure(
    provider: Provider,
    options: { endpoint: string; alias: string },
    execOptions?: McpExecOptions,
  ): Promise<EnsureRegistrationResult> {
    const cliAdapter = this.getCliAdapter(provider);

    if (cliAdapter.mcpProjectRegistrationStrategy === 'upsert') {
      logger.info(
        { provider: provider.name, cwd: execOptions?.cwd },
        'Using upsert strategy (skipping list check)',
      );
      const result = await this.register(
        provider,
        { endpoint: options.endpoint, alias: options.alias },
        execOptions,
      );
      if (!result.success) {
        return {
          success: false,
          action: 'error',
          message: `Failed to register MCP (upsert): ${result.message}`,
        };
      }
      return {
        success: true,
        action: 'added',
        endpoint: options.endpoint,
        alias: options.alias,
      };
    }

    return this.ensureListThenAdd(provider, options, execOptions);
  }

  async resolveBinary(provider: Provider): Promise<McpBinaryResolution> {
    const candidate = provider.binPath ?? provider.name;
    if (!candidate) {
      return {
        success: false,
        message: `No binary candidate available for provider ${provider.name}`,
      };
    }

    const resolved = await resolveBinary(candidate, this.executor);
    if (resolved) {
      return {
        success: true,
        binaryPath: resolved,
        source: path.isAbsolute(candidate) ? 'configured' : 'which',
      };
    }

    logger.warn({ provider: provider.name, candidate }, 'Binary resolution failed');
    return {
      success: false,
      message: `Unable to resolve binary '${candidate}' for provider ${provider.name}.`,
    };
  }

  private async ensureListThenAdd(
    provider: Provider,
    options: { endpoint: string; alias: string },
    execOptions?: McpExecOptions,
  ): Promise<EnsureRegistrationResult> {
    const listResult = await this.list(provider, execOptions);

    logger.info(
      {
        providerId: provider.id,
        success: listResult.success,
        entries: listResult.entries,
      },
      'MCP list registrations result',
    );

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
        'MCP endpoint mismatch, removing and re-adding',
      );

      const removeResult = await this.remove(provider, options.alias, execOptions);
      if (!removeResult.success) {
        return {
          success: false,
          action: 'error',
          message: `Failed to remove existing MCP registration: ${removeResult.message}`,
        };
      }

      const addResult = await this.register(
        provider,
        { endpoint: options.endpoint, alias: options.alias },
        execOptions,
      );
      if (!addResult.success) {
        return {
          success: false,
          action: 'error',
          message: `Failed to re-register MCP after removal: ${addResult.message}`,
        };
      }

      return {
        success: true,
        action: 'fixed_mismatch',
        endpoint: options.endpoint,
        alias: options.alias,
      };
    }

    logger.info({ provider: provider.name }, 'MCP not registered, adding');
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

  private getCliAdapter(provider: Provider): ProviderAdapter & McpCliCapability {
    return this.adapterFactory.getAdapter(provider.name) as ProviderAdapter & McpCliCapability;
  }

  private async execute(
    binaryPath: string,
    args: string[],
    mode: 'pipe' | 'pty',
    options?: McpExecOptions,
  ): Promise<McpCommandResult> {
    const result = await this.executor.run({
      argv: [binaryPath, ...args],
      mode,
      cwd: options?.cwd,
      timeout: options?.timeoutMs,
    });

    if (result.timedOut) {
      return {
        success: false,
        message: `MCP check timed out after ${options?.timeoutMs}ms`,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: null,
        binaryPath,
      };
    }

    if (!result.success) {
      logger.warn(
        { binaryPath, args, code: result.exitCode, stderr: result.stderr },
        'MCP command exited with error',
      );
    }

    return {
      success: result.success,
      message: result.success
        ? 'MCP command completed successfully.'
        : `MCP command exited with code ${result.exitCode}.`,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      binaryPath,
    };
  }
}
