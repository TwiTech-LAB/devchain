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
  type ProjectProvisioningContext,
} from '../../providers/adapters';
import {
  ProjectWriteAdmissionService,
  type RemoteOwnedProject,
} from '../../remotes/admission/project-write-admission.service';
import { ProjectRemoteError, ValidationError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { Provider, UpdateProviderMcpMetadata } from '../../storage/models/domain.models';

const logger = createLogger('ProviderMcpEnsureService');

export type EnsureMcpAction =
  | 'already_configured'
  | 'fixed_mismatch'
  | 'added'
  | 'skipped'
  | 'error';

export type EnsureMcpWarning = {
  source:
    | 'trusted_folders'
    | 'mcp_register'
    | 'claude_settings'
    | 'codex_project_trust'
    | 'provisioning'
    | 'other';
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

export interface EnsureProjectProvisioningResult {
  success: boolean;
  warnings: EnsureMcpWarning[];
}

/**
 * ProviderMcpEnsureService
 * Shared service for ensuring MCP is properly configured for a provider.
 * Includes per-provider locking to prevent concurrent ensure operations.
 */
@Injectable()
export class ProviderMcpEnsureService {
  private ensureLocks = new Map<string, Promise<EnsureMcpResult>>();
  private provisionLocks = new Map<string, Promise<EnsureProjectProvisioningResult>>();

  constructor(
    @Inject('STORAGE_SERVICE') private readonly storage: StorageService,
    private readonly mcpRegistration: McpProviderRegistrationService,
    private readonly adapterFactory: ProviderAdapterFactory,
    private readonly admission: ProjectWriteAdmissionService,
  ) {}

  /**
   * Ensure MCP is properly configured for a provider.
   * Uses per-provider locking to prevent concurrent ensure operations.
   */
  async ensureMcp(
    provider: Provider,
    projectPath?: string,
    context?: ProjectProvisioningContext,
  ): Promise<EnsureMcpResult> {
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
      if (validationResult.remoteOwner) {
        return {
          success: true,
          action: 'skipped',
          message: `Skipped MCP configuration: the project runs on remote "${validationResult.remoteOwner.remoteName ?? validationResult.remoteOwner.remoteId}"; its project config files would carry home's MCP URL to the VM's agents.`,
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
    const promise = this.doEnsureMcp(provider, projectPath, context);
    this.ensureLocks.set(lockKey, promise);

    try {
      return await promise;
    } finally {
      this.ensureLocks.delete(lockKey);
    }
  }

  /**
   * Trust-only provisioning: validate the exact registered project root and run
   * only `provisionProjectPath`. Performs no MCP discovery, no MCP registration,
   * and no project-local settings writes — providers needing those belong on the
   * full `ensureMcp` path. Failures are fixed-code warnings and stay non-fatal.
   */
  async ensureProjectProvisioning(
    provider: Provider,
    projectPath: string,
    context?: ProjectProvisioningContext,
  ): Promise<EnsureProjectProvisioningResult> {
    if (!this.adapterFactory.isSupported(provider.name)) {
      const message = `Provisioning not supported for provider: ${provider.name}`;
      logger.warn({ providerId: provider.id, projectPath }, message);
      return {
        success: false,
        warnings: [
          { source: 'provisioning', level: 'warn', message, code: 'PROVISIONING_UNSUPPORTED' },
        ],
      };
    }

    const validationResult = await this.validateProjectPath(projectPath);
    if (!validationResult.valid) {
      logger.warn(
        { providerId: provider.id, projectPath },
        'Trust-only provisioning path rejected',
      );
      return {
        success: false,
        warnings: [
          {
            source: 'provisioning',
            level: 'warn',
            message: validationResult.message,
            code: 'PROVISIONING_PATH_INVALID',
          },
        ],
      };
    }
    if (validationResult.remoteOwner) {
      const remote = validationResult.remoteOwner;
      logger.info(
        { providerId: provider.id, projectPath, remoteId: remote.remoteId },
        'Trust-only provisioning skipped: project is remote-owned',
      );
      return {
        success: true,
        warnings: [
          {
            source: 'provisioning',
            level: 'info',
            message: `Skipped provisioning: the project runs on remote "${remote.remoteName ?? remote.remoteId}".`,
            code: 'PROVISIONING_REMOTE_OWNED',
          },
        ],
      };
    }

    const lockKey = `provision:${provider.id}:${projectPath}`;
    const existingLock = this.provisionLocks.get(lockKey);
    if (existingLock) {
      logger.debug(
        { providerId: provider.id, projectPath, lockKey },
        'Awaiting existing provision lock',
      );
      return existingLock;
    }

    const promise = this.doEnsureProjectProvisioning(provider, projectPath, context);
    this.provisionLocks.set(lockKey, promise);

    try {
      return await promise;
    } finally {
      this.provisionLocks.delete(lockKey);
    }
  }

  private async doEnsureProjectProvisioning(
    provider: Provider,
    projectPath: string,
    context?: ProjectProvisioningContext,
  ): Promise<EnsureProjectProvisioningResult> {
    try {
      const adapter = this.adapterFactory.getAdapter(provider.name);
      if (!isProjectProvisioningCapable(adapter)) {
        return { success: true, warnings: [] };
      }
      const result =
        context === undefined
          ? await adapter.provisionProjectPath(projectPath)
          : await adapter.provisionProjectPath(projectPath, context);
      return {
        success: result.success,
        warnings: result.warnings.map((w) => ({
          ...w,
          source: w.source as EnsureMcpWarning['source'],
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.warn(
        { error, projectPath, providerName: provider.name },
        'Trust-only provisioning failed (non-fatal)',
      );
      return {
        success: true,
        warnings: [{ source: 'provisioning', level: 'warn', message, code: 'PROVISIONING_FAILED' }],
      };
    }
  }

  /**
   * Internal method that performs the actual MCP ensure operation.
   * Wrapped in try/catch to ensure exceptions don't bypass error handling.
   */
  private async doEnsureMcp(
    provider: Provider,
    projectPath?: string,
    context?: ProjectProvisioningContext,
  ): Promise<EnsureMcpResult> {
    try {
      return await this.doEnsureMcpInternal(provider, projectPath, context);
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
    context?: ProjectProvisioningContext,
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
          const provResult =
            context === undefined
              ? await provAdapter.provisionProjectPath(projectPath)
              : await provAdapter.provisionProjectPath(projectPath, context);
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
   * Resolves a project root path and refuses it when a remote owns the
   * project. Used by the manual registration route, where the user asked for
   * the write explicitly and a 423 naming the remote is clearer than a skip.
   */
  async assertPathNotRemoteOwned(projectPath: string): Promise<void> {
    const result = await this.validateProjectPath(projectPath);
    if (!result.valid) {
      throw new ValidationError(result.message, { projectPath });
    }
    if (result.remoteOwner) {
      const owner = result.remoteOwner;
      throw new ProjectRemoteError(owner.projectId, owner.remoteId, owner.remoteName);
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
  ): Promise<
    { valid: false; message: string } | { valid: true; remoteOwner?: RemoteOwnedProject }
  > {
    // Check 1: Must be absolute path
    if (!isAbsolute(projectPath)) {
      logger.warn({ projectPath }, 'Rejected relative project path');
      return { valid: false, message: 'Project path must be an absolute path' };
    }

    // Check 2: Prevent path traversal attacks. The raw spelling must be checked
    // BEFORE normalize(): normalization consumes `..` segments, so a traversal
    // like /registered/root/../root would otherwise fold back onto a registered
    // root and pass validation. Segment-exact matching keeps names that merely
    // contain '..' as a substring (e.g. `my..project`) valid.
    if (projectPath.split(sep).some((segment) => segment === '..')) {
      logger.warn({ projectPath }, 'Rejected path traversal attempt');
      return { valid: false, message: 'Project path cannot contain path traversal sequences' };
    }

    const normalized = normalize(projectPath);

    // Check 3: Validate against registered projects
    const projects = await this.storage.listProjects({ limit: 1000 });
    const matchingProject = projects.items.find((p) => p.rootPath === normalized);

    if (!matchingProject) {
      logger.warn({ projectPath, normalized }, 'Rejected unregistered project path');
      return { valid: false, message: 'Project path is not a registered project' };
    }

    // A remote-owned project's config files sync to the VM with home's URL;
    // no provider configuration may be written into it from home.
    const remoteOwner = this.admission.getRemoteOwner(matchingProject.id) ?? undefined;

    logger.debug(
      { projectPath, projectId: matchingProject.id, projectName: matchingProject.name },
      'Project path validated successfully',
    );
    return { valid: true, remoteOwner };
  }
}
