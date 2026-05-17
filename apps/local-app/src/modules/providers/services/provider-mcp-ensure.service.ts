import { Injectable, Inject } from '@nestjs/common';
import { isAbsolute, normalize, sep } from 'path';
import { createLogger } from '../../../common/logging/logger';
import { getEnvConfig } from '../../../common/config/env.config';
import { HostResolver } from '@devchain/shared';
import { McpProviderRegistrationService } from '../../providers/services/mcp-provider-registration.service';
import {
  ProviderAdapterFactory,
  isMcpCli,
  isProjectProvisioningCapable,
  isProjectMcpSettingsCapable,
} from '../../providers/adapters';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { Provider, UpdateProviderMcpMetadata } from '../../storage/models/domain.models';

const logger = createLogger('ProviderMcpEnsureService');

export type EnsureMcpAction = 'already_configured' | 'fixed_mismatch' | 'added' | 'error';

export type EnsureMcpWarning = {
  source: 'trusted_folders' | 'mcp_register' | 'claude_settings' | 'provisioning' | 'other';
  level: 'info' | 'warn';
  message: string;
  code?: string;
};

export interface EnsureMcpResult {
  success: boolean;
  action: EnsureMcpAction;
  message?: string;
  endpoint?: string;
  alias?: string;
  warnings?: EnsureMcpWarning[];
}

/**
 * ProviderMcpEnsureService
 * Shared service for ensuring MCP is properly configured for a provider.
 * Includes per-provider locking to prevent concurrent ensure operations.
 */
@Injectable()
export class ProviderMcpEnsureService {
  private ensureLocks = new Map<string, Promise<EnsureMcpResult>>();

  constructor(
    @Inject('STORAGE_SERVICE') private readonly storage: StorageService,
    private readonly mcpRegistration: McpProviderRegistrationService,
    private readonly adapterFactory: ProviderAdapterFactory,
  ) {}

  /**
   * Ensure MCP is properly configured for a provider.
   * Uses per-provider locking to prevent concurrent ensure operations.
   */
  async ensureMcp(provider: Provider, projectPath?: string): Promise<EnsureMcpResult> {
    // Check if provider is supported
    if (!this.adapterFactory.isSupported(provider.name)) {
      return {
        success: false,
        action: 'error',
        message: `MCP ensure not supported for provider: ${provider.name}`,
      };
    }

    // Validate projectPath if provided
    if (projectPath) {
      const validationResult = await this.validateProjectPath(projectPath);
      if (!validationResult.valid) {
        return {
          success: false,
          action: 'error',
          message: validationResult.message,
        };
      }
    }

    // Key by provider + project to ensure project-specific side effects run
    const lockKey = `${provider.id}:${projectPath ?? 'global'}`;

    // Check for existing lock on this provider+project combination
    const existingLock = this.ensureLocks.get(lockKey);
    if (existingLock) {
      logger.debug(
        { providerId: provider.id, projectPath, lockKey },
        'Awaiting existing ensure lock',
      );
      return existingLock;
    }

    // Create new lock and execute
    const promise = this.doEnsureMcp(provider, projectPath);
    this.ensureLocks.set(lockKey, promise);

    try {
      return await promise;
    } finally {
      this.ensureLocks.delete(lockKey);
    }
  }

  /**
   * Internal method that performs the actual MCP ensure operation.
   * Wrapped in try/catch to ensure exceptions don't bypass error handling.
   */
  private async doEnsureMcp(provider: Provider, projectPath?: string): Promise<EnsureMcpResult> {
    try {
      return await this.doEnsureMcpInternal(provider, projectPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error during MCP ensure';
      logger.error(
        { error, providerId: provider.id, projectPath },
        'MCP ensure failed with exception',
      );
      return { success: false, action: 'error', message };
    }
  }

  /**
   * Internal implementation of MCP ensure operation.
   */
  private async doEnsureMcpInternal(
    provider: Provider,
    projectPath?: string,
  ): Promise<EnsureMcpResult> {
    const adapter = this.adapterFactory.getAdapter(provider.name);
    if (!isMcpCli(adapter) && !projectPath) {
      return {
        success: false,
        action: 'error',
        message: `Provider ${provider.name} requires a project path for MCP configuration (uses project config file)`,
      };
    }

    const env = getEnvConfig();
    const expectedEndpoint = `${HostResolver.buildInternalBaseUrl({ host: env.HOST, port: env.PORT })}/mcp`;
    const expectedAlias = 'devchain';
    const warnings: EnsureMcpWarning[] = [];

    logger.info(
      { providerId: provider.id, providerName: provider.name, projectPath },
      'Ensuring MCP configuration',
    );

    // Provider-specific project-local side effects — always run when projectPath is provided
    if (projectPath) {
      const settingsAdapter = this.adapterFactory.getAdapter(provider.name);
      if (isProjectMcpSettingsCapable(settingsAdapter)) {
        try {
          await settingsAdapter.ensureProjectSettings(projectPath);
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Unknown error';
          logger.warn({ error, projectPath }, 'Failed to update project settings (non-fatal)');
          warnings.push({ source: 'claude_settings', level: 'warn', message: msg });
        }
      }
    }

    if (projectPath) {
      try {
        const provAdapter = this.adapterFactory.getAdapter(provider.name);
        if (isProjectProvisioningCapable(provAdapter)) {
          const provResult = await provAdapter.provisionProjectPath(projectPath);
          for (const w of provResult.warnings) {
            warnings.push({ ...w, source: w.source as EnsureMcpWarning['source'] });
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        logger.warn(
          { error, projectPath, providerName: provider.name },
          'Provisioning failed (non-fatal)',
        );
        warnings.push({ source: 'provisioning', level: 'warn', message: msg });
      }
    }

    const ensureResult = await this.mcpRegistration.ensureRegistration(
      provider,
      { endpoint: expectedEndpoint, alias: expectedAlias },
      { cwd: projectPath },
    );

    if (!ensureResult.success) {
      return {
        success: false,
        action: 'error',
        message: ensureResult.message ?? 'MCP ensure failed',
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }

    if (ensureResult.action !== 'already_configured') {
      const metadata: UpdateProviderMcpMetadata = {
        mcpConfigured: true,
        mcpEndpoint: expectedEndpoint,
        mcpRegisteredAt: new Date().toISOString(),
      };
      try {
        await this.storage.updateProviderMcpMetadata(provider.id, metadata);
      } catch (error) {
        logger.warn(
          { error, providerId: provider.id },
          'Failed to update MCP metadata (non-fatal)',
        );
      }
    }

    return {
      success: true,
      action: ensureResult.action,
      endpoint: expectedEndpoint,
      alias: expectedAlias,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Validates that a projectPath is safe and corresponds to a registered project.
   * Security checks:
   * 1. Must be an absolute path
   * 2. Must not contain path traversal sequences (..)
   * 3. Must match a registered project's rootPath
   */
  private async validateProjectPath(
    projectPath: string,
  ): Promise<{ valid: true } | { valid: false; message: string }> {
    // Check 1: Must be absolute path
    if (!isAbsolute(projectPath)) {
      logger.warn({ projectPath }, 'Rejected relative project path');
      return { valid: false, message: 'Project path must be an absolute path' };
    }

    // Check 2: Prevent path traversal attacks (segment-based check to avoid false positives)
    const normalized = normalize(projectPath);
    const segments = normalized.split(sep);
    if (segments.some((segment) => segment === '..')) {
      logger.warn({ projectPath, normalized }, 'Rejected path traversal attempt');
      return { valid: false, message: 'Project path cannot contain path traversal sequences' };
    }

    // Check 3: Validate against registered projects
    const projects = await this.storage.listProjects({ limit: 1000 });
    const matchingProject = projects.items.find((p) => p.rootPath === normalized);

    if (!matchingProject) {
      logger.warn({ projectPath, normalized }, 'Rejected unregistered project path');
      return { valid: false, message: 'Project path is not a registered project' };
    }

    logger.debug(
      { projectPath, projectId: matchingProject.id, projectName: matchingProject.name },
      'Project path validated successfully',
    );
    return { valid: true };
  }
}
