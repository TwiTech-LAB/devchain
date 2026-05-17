import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import type { Provider } from '../../storage/models/domain.models';
import { createLogger } from '../../../common/logging/logger';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { UnsupportedProviderError } from '../../../common/errors/error-types';
import { ProviderAdapterFactory } from '../adapters';
import {
  McpRegistrationPort,
  type McpCommandResult,
  type McpListResult,
  type McpRegisterOptions,
  type McpExecOptions,
  type EnsureRegistrationResult,
} from './mcp-registration';
import { CliMcpRegistrationAdapter, type McpBinaryResolution } from './mcp-registration';

const logger = createLogger('McpProviderRegistrationService');

export type { McpCommandResult, McpListResult, McpRegisterOptions, McpBinaryResolution };

@Injectable()
export class McpProviderRegistrationService implements OnModuleDestroy {
  constructor(
    private readonly port: McpRegistrationPort,
    private readonly cliAdapter: CliMcpRegistrationAdapter,
    private readonly adapterFactory: ProviderAdapterFactory,
    @Inject('STORAGE_SERVICE') private readonly storage: StorageService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    logger.info('Cleaning up MCP registrations on shutdown...');

    try {
      const providersResult = await this.storage.listProviders();
      const codexProvider = providersResult.items.find((p) => p.name === 'codex');

      if (codexProvider?.mcpConfigured) {
        logger.info('Removing devchain MCP registration from Codex...');
        const result = await this.removeRegistration(codexProvider, 'devchain', {
          timeoutMs: 5000,
        });

        if (result.success) {
          logger.info('Codex MCP cleanup complete');
        } else {
          logger.warn({ message: result.message }, 'Codex MCP cleanup returned non-success');
        }
      } else {
        logger.debug('Codex provider not configured with MCP, skipping cleanup');
      }
    } catch (error) {
      logger.error({ error }, 'Failed to cleanup Codex MCP registration');
    }
  }

  async resolveBinary(provider: Provider): Promise<McpBinaryResolution> {
    return this.cliAdapter.resolveBinary(provider);
  }

  async registerProvider(
    provider: Provider,
    options: McpRegisterOptions,
    execOptions?: McpExecOptions,
  ): Promise<McpCommandResult> {
    try {
      return await this.port.register(provider, options, execOptions);
    } catch (error) {
      if (error instanceof UnsupportedProviderError) {
        return { success: false, message: error.message, stdout: '', stderr: '', exitCode: null };
      }
      throw error;
    }
  }

  async listRegistrations(
    provider: Provider,
    execOptions?: McpExecOptions,
  ): Promise<McpListResult> {
    try {
      return await this.port.list(provider, execOptions);
    } catch (error) {
      if (error instanceof UnsupportedProviderError) {
        return { success: false, message: error.message, entries: [], stdout: '', stderr: '' };
      }
      throw error;
    }
  }

  async removeRegistration(
    provider: Provider,
    alias: string,
    execOptions?: McpExecOptions,
  ): Promise<McpCommandResult> {
    try {
      return await this.port.remove(provider, alias, execOptions);
    } catch (error) {
      if (error instanceof UnsupportedProviderError) {
        return { success: false, message: error.message, stdout: '', stderr: '', exitCode: null };
      }
      throw error;
    }
  }

  async ensureRegistration(
    provider: Provider,
    options: { endpoint: string; alias: string },
    execOptions?: McpExecOptions,
  ): Promise<EnsureRegistrationResult> {
    try {
      return await this.port.ensure(provider, options, execOptions);
    } catch (error) {
      if (error instanceof UnsupportedProviderError) {
        return { success: false, action: 'error', message: error.message };
      }
      throw error;
    }
  }
}
