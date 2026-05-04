import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join, isAbsolute, normalize, sep } from 'path';
import { createLogger } from '../../../common/logging/logger';
import { getEnvConfig } from '../../../common/config/env.config';
import { getRuntimeInternalBaseUrl } from '../../../common/config/host-helpers';
import { McpProviderRegistrationService } from '../../mcp/services/mcp-provider-registration.service';
import { ProviderAdapterFactory } from '../../providers/adapters';
import { PreflightService } from './preflight.service';
import { GeminiTrustedFoldersService } from './gemini-trusted-folders.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { Provider, UpdateProviderMcpMetadata } from '../../storage/models/domain.models';

const logger = createLogger('ProviderMcpEnsureService');

export type EnsureMcpAction = 'already_configured' | 'fixed_mismatch' | 'added' | 'error';

export type EnsureMcpWarning = {
  source: 'trusted_folders' | 'mcp_register' | 'claude_settings' | 'other';
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
    private readonly geminiTrustedFolders: GeminiTrustedFoldersService,
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
    if (adapter.mcpMode === 'project_config' && !projectPath) {
      return {
        success: false,
        action: 'error',
        message: `Provider ${provider.name} requires a project path for MCP configuration (uses project config file)`,
      };
    }

    const env = getEnvConfig();
    const expectedEndpoint = `${getRuntimeInternalBaseUrl(env)}/mcp`;
    const expectedAlias = 'devchain';
    const warnings: EnsureMcpWarning[] = [];

    logger.info(
      { providerId: provider.id, providerName: provider.name, projectPath },
      'Ensuring MCP configuration',
    );

    // Provider-specific project-local side effects — always run when projectPath is provided
    if (projectPath && provider.name === 'claude') {
      try {
        await this.ensureClaudeProjectSettings(projectPath);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        logger.warn({ error, projectPath }, 'Failed to update Claude project settings (non-fatal)');
        warnings.push({ source: 'claude_settings', level: 'warn', message: msg });
      }
    }

    if (projectPath && provider.name === 'gemini') {
      try {
        const trustResult = await this.geminiTrustedFolders.ensure(projectPath);
        if (trustResult.action === 'distrusted_warning') {
          warnings.push({
            source: 'trusted_folders',
            level: 'warn',
            message: trustResult.message,
            code: 'GEMINI_PATH_DISTRUSTED',
          });
        } else if (trustResult.action === 'malformed_warning') {
          warnings.push({
            source: 'trusted_folders',
            level: 'warn',
            message: trustResult.message,
            code: 'GEMINI_TRUST_FILE_MALFORMED',
          });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        logger.warn({ error, projectPath }, 'Failed to ensure Gemini trusted folders (non-fatal)');
        warnings.push({
          source: 'trusted_folders',
          level: 'warn',
          message: msg,
          code: 'GEMINI_TRUST_WRITE_FAILED',
        });
      }
    }

    // Upsert routing: adapters that declare upsert skip the list-then-add path
    if (adapter.mcpProjectRegistrationStrategy === 'upsert' && projectPath) {
      logger.info(
        { provider: provider.name, projectPath },
        'Using upsert strategy (skipping list check)',
      );
      const addResult = await this.mcpRegistration.registerProvider(
        provider,
        { endpoint: expectedEndpoint, alias: expectedAlias },
        { cwd: projectPath },
      );
      if (!addResult.success) {
        return {
          success: false,
          action: 'error',
          message: `Failed to register MCP (upsert): ${addResult.message}`,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      }

      try {
        await this.storage.updateProviderMcpMetadata(provider.id, {
          mcpConfigured: true,
          mcpEndpoint: expectedEndpoint,
          mcpRegisteredAt: new Date().toISOString(),
        });
      } catch (error) {
        logger.warn(
          { error, providerId: provider.id },
          'Failed to update MCP metadata (non-fatal)',
        );
      }

      this.preflight.clearCache();
      return {
        success: true,
        action: 'added',
        endpoint: expectedEndpoint,
        alias: expectedAlias,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }

    // List-then-add path (Claude, Codex, OpenCode)
    const listResult = await this.mcpRegistration.listRegistrations(provider, {
      cwd: projectPath,
    });

    logger.info(
      {
        providerId: provider.id,
        success: listResult.success,
        message: listResult.message,
        entries: listResult.entries,
        stdout: listResult.stdout?.substring(0, 500),
        stderr: listResult.stderr?.substring(0, 500),
      },
      'MCP list registrations result',
    );

    if (!listResult.success) {
      logger.error(
        { providerId: provider.id, message: listResult.message },
        'Failed to list MCP registrations',
      );
      return {
        success: false,
        action: 'error',
        message: `Failed to list MCP registrations: ${listResult.message}`,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }

    const existingEntry = listResult.entries.find((e) => e.alias === expectedAlias);
    let action: EnsureMcpAction;

    if (existingEntry) {
      if (existingEntry.endpoint === expectedEndpoint) {
        action = 'already_configured';
        logger.debug({ provider: provider.name }, 'MCP already configured correctly');
      } else {
        logger.info(
          { provider: provider.name, existing: existingEntry.endpoint, expected: expectedEndpoint },
          'MCP endpoint mismatch, removing and re-adding',
        );

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
            warnings: warnings.length > 0 ? warnings : undefined,
          };
        }

        const addResult = await this.mcpRegistration.registerProvider(
          provider,
          { endpoint: expectedEndpoint, alias: expectedAlias },
          { cwd: projectPath },
        );
        if (!addResult.success) {
          return {
            success: false,
            action: 'error',
            message: `Failed to re-register MCP after removal: ${addResult.message}`,
            warnings: warnings.length > 0 ? warnings : undefined,
          };
        }

        action = 'fixed_mismatch';
      }
    } else {
      logger.info({ provider: provider.name }, 'MCP not registered, adding');
      const addResult = await this.mcpRegistration.registerProvider(
        provider,
        { endpoint: expectedEndpoint, alias: expectedAlias },
        { cwd: projectPath },
      );
      if (!addResult.success) {
        return {
          success: false,
          action: 'error',
          message: `Failed to register MCP: ${addResult.message}`,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      }

      action = 'added';
    }

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
      }
    }

    this.preflight.clearCache();
    logger.debug('Cleared preflight cache after MCP ensure');

    return {
      success: true,
      action,
      endpoint: expectedEndpoint,
      alias: expectedAlias,
      warnings: warnings.length > 0 ? warnings : undefined,
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
