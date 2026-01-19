import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join, isAbsolute, normalize, sep } from 'path';
import { createLogger } from '../../../common/logging/logger';
import { getEnvConfig } from '../../../common/config/env.config';
import { McpProviderRegistrationService } from '../../mcp/services/mcp-provider-registration.service';
import { ProviderAdapterFactory } from '../../providers/adapters';
import { PreflightService } from './preflight.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { Provider, UpdateProviderMcpMetadata } from '../../storage/models/domain.models';

const logger = createLogger('ProviderMcpEnsureService');

export type EnsureMcpAction = 'already_configured' | 'fixed_mismatch' | 'added' | 'error';

export interface EnsureMcpResult {
  success: boolean;
  action: EnsureMcpAction;
  message?: string;
  endpoint?: string;
  alias?: string;
}

interface ClaudeSettingsLocal {
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
  [key: string]: unknown;
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
    @Inject(forwardRef(() => McpProviderRegistrationService))
    private readonly mcpRegistration: McpProviderRegistrationService,
    private readonly adapterFactory: ProviderAdapterFactory,
    @Inject(forwardRef(() => PreflightService))
    private readonly preflight: PreflightService,
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
    const env = getEnvConfig();
    const expectedEndpoint = `http://127.0.0.1:${env.PORT}/mcp`;
    const expectedAlias = 'devchain';

    logger.info(
      { providerId: provider.id, providerName: provider.name, projectPath },
      'Ensuring MCP configuration',
    );

    // List current registrations with project context
    const listResult = await this.mcpRegistration.listRegistrations(provider, {
      cwd: projectPath,
    });

    if (!listResult.success) {
      logger.error(
        { providerId: provider.id, message: listResult.message },
        'Failed to list MCP registrations',
      );
      return {
        success: false,
        action: 'error',
        message: `Failed to list MCP registrations: ${listResult.message}`,
      };
    }

    // Check if devchain alias exists
    const existingEntry = listResult.entries.find((e) => e.alias === expectedAlias);
    let action: EnsureMcpAction;

    if (existingEntry) {
      if (existingEntry.endpoint === expectedEndpoint) {
        // Already configured correctly
        action = 'already_configured';
        logger.debug({ provider: provider.name }, 'MCP already configured correctly');
      } else {
        // Endpoint mismatch - remove and re-add
        logger.info(
          { provider: provider.name, existing: existingEntry.endpoint, expected: expectedEndpoint },
          'MCP endpoint mismatch, removing and re-adding',
        );

        // Remove existing
        const removeResult = await this.mcpRegistration.removeRegistration(
          provider,
          expectedAlias,
          { cwd: projectPath },
        );
        if (!removeResult.success) {
          return {
            success: false,
            action: 'error',
            message: `Failed to remove existing MCP registration: ${removeResult.message}`,
          };
        }

        // Add with correct endpoint
        const addResult = await this.mcpRegistration.registerProvider(
          provider,
          {
            endpoint: expectedEndpoint,
            alias: expectedAlias,
          },
          { cwd: projectPath },
        );
        if (!addResult.success) {
          return {
            success: false,
            action: 'error',
            message: `Failed to re-register MCP after removal: ${addResult.message}`,
          };
        }

        action = 'fixed_mismatch';
      }
    } else {
      // Not registered - add it
      logger.info({ provider: provider.name }, 'MCP not registered, adding');
      const addResult = await this.mcpRegistration.registerProvider(
        provider,
        {
          endpoint: expectedEndpoint,
          alias: expectedAlias,
        },
        { cwd: projectPath },
      );
      if (!addResult.success) {
        return {
          success: false,
          action: 'error',
          message: `Failed to register MCP: ${addResult.message}`,
        };
      }

      action = 'added';
    }

    // Update metadata if changed (best-effort - MCP registration already succeeded)
    if (action !== 'already_configured') {
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
        // Don't fail the request - MCP registration already succeeded
      }

      // For Claude provider, ensure project settings file has mcp__devchain allowed
      if (projectPath && provider.name === 'claude') {
        try {
          await this.ensureClaudeProjectSettings(projectPath);
        } catch (error) {
          logger.warn(
            { error, projectPath },
            'Failed to update Claude project settings (non-fatal)',
          );
          // Don't fail the request - MCP registration already succeeded
        }
      }
    }

    // Clear preflight cache so subsequent checks reflect the update
    this.preflight.clearCache();
    logger.debug('Cleared preflight cache after MCP ensure');

    return {
      success: true,
      action,
      endpoint: expectedEndpoint,
      alias: expectedAlias,
    };
  }

  /**
   * Ensures the Claude project settings file exists and has mcp__devchain in the allow list.
   * Creates .claude/settings.local.json if it doesn't exist, or updates it if needed.
   */
  private async ensureClaudeProjectSettings(projectPath: string): Promise<void> {
    const settingsDir = join(projectPath, '.claude');
    const settingsPath = join(settingsDir, 'settings.local.json');
    const permission = 'mcp__devchain';

    // Ensure .claude directory exists
    await mkdir(settingsDir, { recursive: true });

    // Read existing file or start with empty structure
    let settings: ClaudeSettingsLocal;
    try {
      const content = await readFile(settingsPath, 'utf-8');
      settings = JSON.parse(content);
    } catch {
      // File doesn't exist or invalid JSON - start fresh
      settings = { permissions: { allow: [], deny: [], ask: [] } };
    }

    // Ensure permissions structure exists
    if (!settings.permissions) {
      settings.permissions = { allow: [], deny: [], ask: [] };
    }
    if (!Array.isArray(settings.permissions.allow)) {
      settings.permissions.allow = [];
    }

    // Add permission if not already present
    if (!settings.permissions.allow.includes(permission)) {
      settings.permissions.allow.push(permission);
      await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
      logger.info({ projectPath, settingsPath }, 'Added mcp__devchain to Claude settings');
    }
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
