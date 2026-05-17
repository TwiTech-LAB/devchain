import type {
  ProviderAdapter,
  McpServerEntry,
  AddMcpServerOptions,
} from '../provider-adapter.interface';
import type { ContextWindowCapability } from './context-window.capability';
import type { HookCapability } from './hook.capability';
import type { ProjectProvisioningCapability } from './project-provisioning.capability';
import type { ProjectMcpSettingsCapability } from './project-mcp-settings.capability';
import type { TranscriptDiscoveryCapability } from './transcript-discovery.capability';
export type {
  ContextWindowCapability,
  ContextWindowProviderState,
  ModelFamily,
} from './context-window.capability';
export type { HookCapability, HookEnvContext } from './hook.capability';
export type {
  ProjectProvisioningCapability,
  ProvisioningResult,
  ProvisioningWarningItem,
} from './project-provisioning.capability';
export type { ProjectMcpSettingsCapability } from './project-mcp-settings.capability';
export type { TranscriptDiscoveryCapability } from './transcript-discovery.capability';

export interface ConfigFileMcpCapability {
  readonly configFileName: string;
  parseProjectConfig(content: string): McpServerEntry[];
  buildMcpConfigEntry(options: AddMcpServerOptions): {
    key: string;
    value: Record<string, unknown>;
  };
}

export function isConfigFileMcpCapable(
  adapter: ProviderAdapter,
): adapter is ProviderAdapter & ConfigFileMcpCapability {
  return (
    'configFileName' in adapter &&
    'parseProjectConfig' in adapter &&
    'buildMcpConfigEntry' in adapter
  );
}

export interface McpCliCapability {
  readonly mcpListSpawnMode?: 'pipe' | 'pty';
  readonly mcpProjectRegistrationStrategy?: 'list_then_add' | 'upsert';
  addMcpServer(options: AddMcpServerOptions): string[];
  listMcpServers(): string[];
  removeMcpServer(alias: string): string[];
  binaryCheck(alias: string): string[];
  parseListOutput(stdout: string, stderr?: string): McpServerEntry[];
}

export function isMcpCli(adapter: ProviderAdapter): adapter is ProviderAdapter & McpCliCapability {
  return (adapter as unknown as Record<string, unknown>).mcpMode !== 'project_config';
}

export function isContextWindowCapable(
  adapter: ProviderAdapter,
): adapter is ProviderAdapter & ContextWindowCapability {
  return 'applyContextWindowConfig' in adapter;
}

export function isHookCapable(
  adapter: ProviderAdapter,
): adapter is ProviderAdapter & HookCapability {
  return 'hooksEnabled' in adapter;
}

export function isProjectProvisioningCapable(
  adapter: ProviderAdapter,
): adapter is ProviderAdapter & ProjectProvisioningCapability {
  return 'provisionProjectPath' in adapter;
}

export function isTranscriptDiscoveryCapable(
  adapter: ProviderAdapter,
): adapter is ProviderAdapter & TranscriptDiscoveryCapability {
  return 'transcriptDiscoveryStrategy' in adapter;
}

export function isProjectMcpSettingsCapable(
  adapter: unknown,
): adapter is ProjectMcpSettingsCapability {
  return typeof (adapter as Record<string, unknown>).ensureProjectSettings === 'function';
}
