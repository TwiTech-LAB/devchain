import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import { access, mkdir, constants } from 'fs/promises';
import { createLogger } from '../../../common/logging/logger';
import * as path from 'path';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { AgentProfile, Provider } from '../../storage/models/domain.models';
import { McpProviderRegistrationService } from '../../mcp/services/mcp-provider-registration.service';
import { parseProfileOptions, ProfileOptionsError } from '../../sessions/utils/profile-options';
import { ProviderAdapterFactory } from '../../providers/adapters';

const execAsync = promisify(exec);
const logger = createLogger('PreflightService');

export interface PreflightCheck {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  details?: string;
}

export interface ProviderCheck {
  id: string;
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  details?: string;
  binPath: string | null;
  binaryStatus: 'pass' | 'fail' | 'warn';
  binaryMessage: string;
  binaryDetails?: string;
  mcpStatus?: 'pass' | 'fail' | 'warn';
  mcpMessage?: string;
  mcpDetails?: string;
  mcpEndpoint?: string | null;
}

export interface PreflightResult {
  overall: 'pass' | 'fail' | 'warn';
  checks: PreflightCheck[];
  providers: ProviderCheck[];
  supportedMcpProviders: string[];
  timestamp: string;
}

interface CachedResult {
  result: PreflightResult;
  expiresAt: number;
}

/**
 * PreflightService
 * Performs system checks before allowing session start
 * Results are cached for 60 seconds to reduce load
 */
@Injectable()
export class PreflightService {
  private cache: Map<string, CachedResult> = new Map();
  private readonly CACHE_TTL_MS = 60000; // 60 seconds

  constructor(
    @Inject('STORAGE_SERVICE') private readonly storage: StorageService,
    @Inject(forwardRef(() => McpProviderRegistrationService))
    private readonly mcpRegistration: McpProviderRegistrationService,
    private readonly adapterFactory: ProviderAdapterFactory,
  ) {}

  /**
   * Run all preflight checks (with caching)
   */
  async runChecks(projectPath?: string): Promise<PreflightResult> {
    const cacheKey = projectPath || '';

    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      logger.debug({ projectPath, cacheHit: true }, 'Returning cached preflight results');
      return cached.result;
    }

    if (process.env.SKIP_PREFLIGHT === '1') {
      const result: PreflightResult = {
        overall: 'pass',
        checks: [
          {
            name: 'preflight',
            status: 'pass',
            message: 'Preflight checks skipped (test mode)',
          },
        ],
        providers: [],
        supportedMcpProviders: this.adapterFactory.getSupportedProviders(),
        timestamp: new Date().toISOString(),
      };

      this.cache.set(cacheKey, {
        result,
        expiresAt: Date.now() + this.CACHE_TTL_MS,
      });

      return result;
    }

    logger.info({ projectPath }, 'Running preflight checks');

    const checks: PreflightCheck[] = [];
    const providerChecks: ProviderCheck[] = [];

    // Check tmux
    checks.push(await this.checkTmux());

    let profiles: AgentProfile[] = [];
    let scopedProjectId: string | null | undefined = undefined;
    if (projectPath) {
      try {
        const project = await this.storage.findProjectByPath(projectPath);
        scopedProjectId = project?.id;
        logger.debug(
          { projectPath, projectId: scopedProjectId },
          'Resolved project for preflight profile scoping',
        );
      } catch (e) {
        logger.warn({ projectPath }, 'Failed to resolve project by path for preflight');
      }
    }

    try {
      const profileResult = await this.storage.listAgentProfiles(
        scopedProjectId ? { projectId: scopedProjectId } : {},
      );
      profiles = profileResult.items ?? [];
    } catch (error) {
      logger.error({ error }, 'Failed to fetch agent profiles for preflight checks');
      checks.push({
        name: 'profiles',
        status: 'warn',
        message: 'Failed to inspect agent profiles for options validation',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    // Check all configured providers dynamically
    try {
      const providersResult = await this.storage.listProviders();
      logger.debug(
        { providerCount: providersResult.items.length },
        'Fetched providers for preflight',
      );

      for (const provider of providersResult.items) {
        const relevantProfiles = profiles.filter((profile) => profile.providerId === provider.id);
        providerChecks.push(await this.checkProvider(provider, relevantProfiles, projectPath));
      }
    } catch (error) {
      logger.error({ error }, 'Failed to fetch providers for preflight checks');
      // Add a warning check if we can't fetch providers
      checks.push({
        name: 'providers',
        status: 'warn',
        message: 'Failed to fetch provider configuration',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    // Check project .devchain/ write access if project path provided
    if (projectPath) {
      checks.push(await this.checkDevchainAccess(projectPath));
    }

    // Determine overall status (including provider checks)
    const hasFail =
      checks.some((c) => c.status === 'fail') || providerChecks.some((p) => p.status === 'fail');
    const hasWarn =
      checks.some((c) => c.status === 'warn') || providerChecks.some((p) => p.status === 'warn');
    const overall = hasFail ? 'fail' : hasWarn ? 'warn' : 'pass';

    const result: PreflightResult = {
      overall,
      checks,
      providers: providerChecks,
      supportedMcpProviders: this.adapterFactory.getSupportedProviders(),
      timestamp: new Date().toISOString(),
    };

    // Cache the result
    this.cache.set(cacheKey, {
      result,
      expiresAt: Date.now() + this.CACHE_TTL_MS,
    });

    logger.info(
      { overall, checkCount: checks.length, providerCount: providerChecks.length },
      'Preflight checks completed',
    );
    return result;
  }

  private async evaluateMcpStatus(
    provider: Provider,
    projectPath?: string,
  ): Promise<{
    mcpStatus: 'pass' | 'fail' | 'warn';
    mcpMessage?: string;
    mcpDetails?: string;
  }> {
    if (!this.isMcpSupported(provider.name)) {
      return {
        mcpStatus: 'pass',
        mcpMessage: 'MCP not required for this provider.',
      };
    }

    // Compute expected endpoint using runtime config
    const { getEnvConfig } = await import('../../../common/config/env.config');
    const env = getEnvConfig();
    const expectedEndpoint = `http://127.0.0.1:${env.PORT}/mcp`;
    const expectedAlias = 'devchain';

    const listResult = await this.mcpRegistration.listRegistrations(provider, {
      cwd: projectPath,
    });
    if (!listResult.success) {
      return {
        mcpStatus: 'fail',
        mcpMessage: listResult.message,
        mcpDetails: undefined,
      };
    }

    // Find devchain alias entry
    const devchainEntry = listResult.entries.find((entry) => entry.alias === expectedAlias);

    if (!devchainEntry) {
      return {
        mcpStatus: 'warn',
        mcpMessage: `MCP alias '${expectedAlias}' not found.`,
        mcpDetails: `Run Configure MCP or use ensure endpoint to add: ${expectedEndpoint}`,
      };
    }

    // Verify endpoint matches exactly
    if (devchainEntry.endpoint !== expectedEndpoint) {
      return {
        mcpStatus: 'warn',
        mcpMessage: `MCP endpoint mismatch for alias '${expectedAlias}'.`,
        mcpDetails: `Expected: ${expectedEndpoint}, Found: ${devchainEntry.endpoint}. Run Configure MCP or use ensure endpoint to fix.`,
      };
    }

    return {
      mcpStatus: 'pass',
      mcpMessage: `MCP registered correctly (${expectedAlias} → ${expectedEndpoint}).`,
    };
  }

  private isMcpSupported(name: string): boolean {
    return this.adapterFactory.isSupported(name);
  }

  /**
   * Check tmux availability and version
   */
  private async checkTmux(): Promise<PreflightCheck> {
    try {
      const { stdout } = await execAsync('tmux -V');
      const version = stdout.trim();

      // Parse version number with improved handling for non-semver formats
      // Handles: "tmux 3.2", "tmux 3.2a", "tmux next-3.3", "tmux 3.4-rc"
      const versionMatch = version.match(/tmux\s+(?:next-)?(\d+)\.?(\d+)?/);
      if (!versionMatch) {
        // If we can't parse version, still allow but warn
        return {
          name: 'tmux',
          status: 'warn',
          message: 'tmux found but version could not be parsed',
          details: `Output: "${version}". This may still work if tmux is properly installed.`,
        };
      }

      const major = parseInt(versionMatch[1], 10);
      const minor = versionMatch[2] ? parseInt(versionMatch[2], 10) : 0;
      const versionNum = major + minor / 10;

      if (versionNum < 2.6) {
        return {
          name: 'tmux',
          status: 'warn',
          message: `tmux ${version} found (recommend 2.6+)`,
          details: 'Older versions may have compatibility issues with session management',
        };
      }

      return {
        name: 'tmux',
        status: 'pass',
        message: `tmux ${version} found`,
      };
    } catch (error) {
      return {
        name: 'tmux',
        status: 'fail',
        message: 'tmux not found',
        details: 'Install tmux: apt-get install tmux (Debian/Ubuntu) or brew install tmux (macOS)',
      };
    }
  }

  /**
   * Check if a provider binary exists and is executable
   */
  private async checkProvider(
    provider: Provider,
    profiles: AgentProfile[],
    projectPath?: string,
  ): Promise<ProviderCheck> {
    let binaryStatus: 'pass' | 'fail' | 'warn' = 'warn';
    let binaryMessage = `${provider.name} binary not configured`;
    let binaryDetails: string | undefined;
    let resolvedBinPath: string | null = provider.binPath ?? null;

    try {
      if (provider.binPath && path.isAbsolute(provider.binPath)) {
        await access(provider.binPath, constants.X_OK);
        binaryStatus = 'pass';
        binaryMessage = `${provider.name} binary found at ${provider.binPath}`;
      } else {
        const resolution = await this.mcpRegistration.resolveBinary(provider);
        if (resolution.success && resolution.binaryPath) {
          binaryStatus = 'pass';
          resolvedBinPath = resolution.binaryPath;
          binaryMessage = `${provider.name} binary available at ${resolution.binaryPath}`;
          binaryDetails = resolution.source === 'which' ? 'Discovered via PATH lookup.' : undefined;
        } else {
          binaryStatus = 'warn';
          binaryDetails =
            resolution.message ??
            'Set a binary path or ensure the binary is on PATH via Providers settings.';
        }
      }
    } catch (error) {
      binaryStatus = 'fail';
      binaryMessage = `${provider.name} binary not accessible`;
      binaryDetails =
        error instanceof Error
          ? error.message
          : 'Binary is either missing or not executable. Check file permissions.';
    }

    let optionsStatus: 'pass' | 'fail' | 'warn' = 'pass';
    let optionsMessage: string | undefined;
    let optionsDetails: string | undefined;

    const optionErrors: string[] = [];

    for (const profile of profiles) {
      if (!profile.options) {
        continue;
      }

      try {
        parseProfileOptions(profile.options);
      } catch (error) {
        if (error instanceof ProfileOptionsError) {
          optionsStatus = 'fail';
          optionErrors.push(`${profile.name}: ${error.message}`);
        } else {
          optionsStatus = 'fail';
          optionErrors.push(`${profile.name}: invalid options`);
        }
      }
    }

    if (optionErrors.length > 0) {
      optionsMessage = `Invalid options in ${optionErrors.length} profile${optionErrors.length === 1 ? '' : 's'}.`;
      optionsDetails = optionErrors.join(' | ');
    }

    const { mcpStatus, mcpMessage, mcpDetails } = await this.evaluateMcpStatus(
      provider,
      projectPath,
    );
    const statusCollection: Array<'pass' | 'fail' | 'warn'> = [
      binaryStatus,
      mcpStatus,
      optionsStatus,
    ];
    const overallStatus = statusCollection.includes('fail')
      ? 'fail'
      : statusCollection.includes('warn')
        ? 'warn'
        : 'pass';

    const summaryMessage =
      optionsStatus === overallStatus && optionsMessage
        ? optionsMessage
        : binaryStatus === overallStatus
          ? binaryMessage
          : (mcpMessage ?? binaryMessage);

    const combinedDetails =
      [binaryDetails, optionsDetails, mcpDetails].filter(Boolean).join(' | ') || undefined;

    return {
      id: provider.id,
      name: provider.name,
      binPath: resolvedBinPath,
      status: overallStatus,
      message: summaryMessage,
      details: combinedDetails,
      binaryStatus,
      binaryMessage,
      binaryDetails,
      mcpStatus,
      mcpMessage,
      mcpDetails,
      mcpEndpoint: provider.mcpEndpoint,
    };
  }

  /**
   * Check write access to project .devchain/ directory
   */
  private async checkDevchainAccess(projectPath: string): Promise<PreflightCheck> {
    try {
      const devchainPath = path.join(projectPath, '.devchain');

      // Try to access directory
      try {
        await access(devchainPath, constants.W_OK);
        return {
          name: '.devchain access',
          status: 'pass',
          message: `Write access to ${devchainPath} verified`,
        };
      } catch (accessError) {
        // Directory might not exist, try to create it
        try {
          await mkdir(devchainPath, { recursive: true });
          return {
            name: '.devchain access',
            status: 'pass',
            message: `Created ${devchainPath} with write access`,
          };
        } catch (mkdirError) {
          return {
            name: '.devchain access',
            status: 'fail',
            message: `Cannot create/write to ${devchainPath}`,
            details: `Error: ${mkdirError instanceof Error ? mkdirError.message : 'Unknown error'}. Check directory permissions.`,
          };
        }
      }
    } catch (error) {
      return {
        name: '.devchain access',
        status: 'fail',
        message: 'Failed to check .devchain directory',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get single check by name
   */
  async getCheck(checkName: string, projectPath?: string): Promise<PreflightCheck> {
    const result = await this.runChecks(projectPath);
    const check = result.checks.find((c) => c.name === checkName);
    if (!check) {
      throw new Error(`Check not found: ${checkName}`);
    }
    return check;
  }

  /**
   * Clear cache for a specific project path (or all if not specified)
   */
  clearCache(projectPath?: string): void {
    if (projectPath !== undefined) {
      const cacheKey = projectPath || '';
      this.cache.delete(cacheKey);
      logger.debug({ projectPath }, 'Cleared preflight cache');
    } else {
      this.cache.clear();
      logger.debug('Cleared all preflight cache');
    }
  }
}
