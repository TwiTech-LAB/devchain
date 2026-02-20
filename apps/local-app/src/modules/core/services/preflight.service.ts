import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import { access, mkdir, constants } from 'fs/promises';
import { createLogger } from '../../../common/logging/logger';
import * as path from 'path';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type {
  AgentProfile,
  Provider,
  ProfileProviderConfig,
} from '../../storage/models/domain.models';
import {
  validateEnvKey,
  validateEnvValue,
  EnvBuilderError,
} from '../../sessions/utils/env-builder';
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
  /** Config details when validated via agent's providerConfigId */
  configId?: string;
  configEnvStatus?: 'pass' | 'fail' | 'warn';
  configEnvMessage?: string;
  /** Agent names using this provider */
  usedByAgents?: string[];
}

export interface PreflightResult {
  overall: 'pass' | 'fail' | 'warn';
  checks: PreflightCheck[];
  providers: ProviderCheck[];
  supportedMcpProviders: string[];
  timestamp: string;
}

/**
 * PreflightService
 * Performs system checks before allowing session start
 */
@Injectable()
export class PreflightService {
  constructor(
    @Inject('STORAGE_SERVICE') private readonly storage: StorageService,
    @Inject(forwardRef(() => McpProviderRegistrationService))
    private readonly mcpRegistration: McpProviderRegistrationService,
    private readonly adapterFactory: ProviderAdapterFactory,
  ) {}

  /**
   * Collect provider info from project's agents.
   * Returns a map of providerId → { provider, profiles, configs, agentNames }
   *
   * Uses batch loading to avoid N+1 query patterns:
   * - Batch-loads all provider configs by IDs
   * - Batch-loads all providers by IDs
   */
  private async collectProviderInfoFromAgents(projectId: string | null | undefined): Promise<
    Map<
      string,
      {
        provider: Provider;
        profiles: AgentProfile[];
        configs: ProfileProviderConfig[];
        agentNames: string[];
      }
    >
  > {
    const providerMap = new Map<
      string,
      {
        provider: Provider;
        profiles: AgentProfile[];
        configs: ProfileProviderConfig[];
        agentNames: string[];
      }
    >();

    // If no projectId, fall back to validating all providers
    // Note: Profile-provider relationship now determined via profile_provider_configs
    if (!projectId) {
      const providersResult = await this.storage.listProviders();
      const allConfigs = await this.storage.listAllProfileProviderConfigs();
      for (const provider of providersResult.items) {
        // Get profiles that have configs for this provider
        const providerConfigs = allConfigs.filter((c) => c.providerId === provider.id);
        providerMap.set(provider.id, {
          provider,
          profiles: [], // Profiles no longer directly linked to providers
          configs: providerConfigs,
          agentNames: [],
        });
      }
      return providerMap;
    }

    // Get agents for the project
    const agentsResult = await this.storage.listAgents(projectId);
    const agents = agentsResult.items;

    // Collect distinct config IDs from agents
    const configIds = [
      ...new Set(agents.filter((a) => a.providerConfigId).map((a) => a.providerConfigId)),
    ];

    if (configIds.length === 0) {
      // No agents with configs
      return providerMap;
    }

    // Batch-load all configs in a single query
    const configs = await this.storage.listProfileProviderConfigsByIds(configIds);
    const configMap = new Map(configs.map((c) => [c.id, c]));

    // Collect distinct provider IDs from configs
    const providerIds = [...new Set(configs.map((c) => c.providerId))];

    // Batch-load all providers in a single query
    const providers = await this.storage.listProvidersByIds(providerIds);
    const providerLookup = new Map(providers.map((p) => [p.id, p]));

    // Build the result map using in-memory lookups
    for (const agent of agents) {
      if (!agent.providerConfigId) {
        logger.warn({ agentId: agent.id }, 'Agent has no providerConfigId');
        continue;
      }

      const config = configMap.get(agent.providerConfigId);
      if (!config) {
        logger.warn({ agentId: agent.id, configId: agent.providerConfigId }, 'Config not found');
        continue;
      }

      const providerId = config.providerId;
      const provider = providerLookup.get(providerId);
      if (!provider) {
        logger.warn({ agentId: agent.id, providerId }, 'Provider not found');
        continue;
      }

      // Add to map
      if (!providerMap.has(providerId)) {
        providerMap.set(providerId, {
          provider,
          profiles: [],
          configs: [],
          agentNames: [],
        });
      }

      const info = providerMap.get(providerId)!;
      info.agentNames.push(agent.name);

      // Add config to the list if not already present
      if (!info.configs.some((c) => c.id === config.id)) {
        info.configs.push(config);
      }
    }

    return providerMap;
  }

  /**
   * Run all preflight checks
   */
  async runChecks(projectPath?: string): Promise<PreflightResult> {
    if (process.env.SKIP_PREFLIGHT === '1') {
      return {
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
    }

    logger.info({ projectPath }, 'Running preflight checks');

    const checks: PreflightCheck[] = [];
    const providerChecks: ProviderCheck[] = [];

    // Check tmux
    checks.push(await this.checkTmux());

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

    // Collect provider info from agents' configs (only validate what's actually used)
    try {
      const providerInfoMap = await this.collectProviderInfoFromAgents(scopedProjectId);
      const enabledProviders = this.getEnabledProvidersFilter();
      logger.debug(
        { providerCount: providerInfoMap.size, enabledProviders: enabledProviders ?? 'all' },
        'Collected providers from agent configs for preflight',
      );

      for (const info of providerInfoMap.values()) {
        if (
          enabledProviders &&
          !enabledProviders.has((info.provider.name ?? '').trim().toLowerCase())
        ) {
          logger.debug(
            { provider: info.provider.name },
            'Skipping provider check because it is not in ENABLED_PROVIDERS',
          );
          continue;
        }
        providerChecks.push(
          await this.checkProviderWithConfig(
            info.provider,
            info.profiles,
            info.configs,
            info.agentNames,
            projectPath,
          ),
        );
      }
    } catch (error) {
      logger.error({ error }, 'Failed to collect provider info for preflight checks');
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

    logger.info(
      { overall, checkCount: checks.length, providerCount: providerChecks.length },
      'Preflight checks completed',
    );
    return result;
  }

  private getEnabledProvidersFilter(): Set<string> | null {
    const raw = process.env.ENABLED_PROVIDERS;
    if (raw === undefined) {
      return null;
    }

    const values = raw
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    return new Set(values);
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

    // Options validation moved to checkProviderWithConfig (uses config.options, not profile.options)

    const { mcpStatus, mcpMessage, mcpDetails } = await this.evaluateMcpStatus(
      provider,
      projectPath,
    );
    const statusCollection: Array<'pass' | 'fail' | 'warn'> = [binaryStatus, mcpStatus];
    const overallStatus = statusCollection.includes('fail')
      ? 'fail'
      : statusCollection.includes('warn')
        ? 'warn'
        : 'pass';

    const summaryMessage =
      binaryStatus === overallStatus ? binaryMessage : (mcpMessage ?? binaryMessage);

    const combinedDetails = [binaryDetails, mcpDetails].filter(Boolean).join(' | ') || undefined;

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
   * Check provider with config details (env validation)
   */
  private async checkProviderWithConfig(
    provider: Provider,
    profiles: AgentProfile[],
    configs: ProfileProviderConfig[],
    agentNames: string[],
    projectPath?: string,
  ): Promise<ProviderCheck> {
    // Get base provider check
    const baseCheck = await this.checkProvider(provider, profiles, projectPath);

    // Validate configs' env vars
    let configEnvStatus: 'pass' | 'fail' | 'warn' = 'pass';
    let configEnvMessage: string | undefined;
    const envErrors: string[] = [];

    for (const config of configs) {
      if (!config.env) {
        continue;
      }

      for (const [key, value] of Object.entries(config.env)) {
        try {
          validateEnvKey(key);
          validateEnvValue(key, value);
        } catch (error) {
          configEnvStatus = 'fail';
          if (error instanceof EnvBuilderError) {
            envErrors.push(`Config ${config.id.slice(0, 8)}: ${error.message}`);
          } else {
            envErrors.push(`Config ${config.id.slice(0, 8)}: invalid env var`);
          }
        }
      }
    }

    if (envErrors.length > 0) {
      configEnvMessage = `Invalid env vars: ${envErrors.join(' | ')}`;
    }

    // Validate config options
    const configOptionErrors: string[] = [];
    for (const config of configs) {
      if (!config.options) {
        continue;
      }

      try {
        parseProfileOptions(config.options);
      } catch (error) {
        if (error instanceof ProfileOptionsError) {
          configOptionErrors.push(`Config ${config.id.slice(0, 8)}: ${error.message}`);
        } else {
          configOptionErrors.push(`Config ${config.id.slice(0, 8)}: invalid options`);
        }
      }
    }

    // Combine status
    const statusCollection: Array<'pass' | 'fail' | 'warn'> = [
      baseCheck.status,
      configEnvStatus,
      configOptionErrors.length > 0 ? 'fail' : 'pass',
    ];
    const overallStatus = statusCollection.includes('fail')
      ? 'fail'
      : statusCollection.includes('warn')
        ? 'warn'
        : 'pass';

    // Build combined details
    const allDetails = [
      baseCheck.details,
      configEnvMessage,
      configOptionErrors.length > 0
        ? `Config options: ${configOptionErrors.join(' | ')}`
        : undefined,
    ]
      .filter(Boolean)
      .join(' | ');

    return {
      ...baseCheck,
      status: overallStatus,
      details: allDetails || undefined,
      configEnvStatus,
      configEnvMessage,
      usedByAgents: agentNames.length > 0 ? agentNames : undefined,
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
   * No-op - cache has been removed.
   * Kept for backward compatibility with callers.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  clearCache(_projectPath?: string): void {
    // No-op - preflight no longer uses caching
  }
}
