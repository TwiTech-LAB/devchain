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

/**
 * Result of a best-effort, non-blocking authentication probe. `authenticated`
 * is a HINT (false-negatives possible when a provider authenticates via an OS
 * keyring devchain can't cheaply inspect), so consumers surface a WARNING — they
 * never hard-block launch on it. `remediation` is the actionable fix to show.
 */
export interface AuthProbeResult {
  authenticated: boolean;
  remediation: string;
}

/**
 * A provider that exposes a cheap, best-effort auth-state probe for preflight.
 * Adopter: Copilot (S1 — no `login --status` command; probes env tokens +
 * `~/.copilot/config.json` `loggedInUsers[]`).
 */
export interface AuthProbeCapability {
  probeAuth(): Promise<AuthProbeResult>;
}

export function isAuthProbeCapable(
  adapter: ProviderAdapter,
): adapter is ProviderAdapter & AuthProbeCapability {
  return 'probeAuth' in adapter;
}

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

/**
 * Marks a provider whose MCP servers live in a single HOME-global JSON config
 * file (not a project-local file, and not a CLI `mcp add` subcommand). Today's
 * adopter is Antigravity (`agy`), which reads `~/.gemini/config/mcp_config.json`
 * with a windsurf-style `{ "mcpServers": { "<name>": { "serverUrl": … } } }`
 * shape — distinct from the opencode-flat `{ "mcp": { "<alias>": … } }` project
 * config (different root key, `serverUrl` transport field, and a home-global
 * location). `McpRegistrationPort` routes these adapters to the dedicated
 * `AntigravityMcpRegistrationAdapter` (the file IO + `mcpServers` merge), which
 * delegates the schema specifics back to these two methods.
 *
 * Two-adapter rule: this is a real port adapter (a third `McpRegistrationAdapter`
 * alongside CLI + ConfigFile), not a speculative capability.
 */
export interface GlobalMcpConfigCapability {
  /** Parse the global MCP config file content into discovered server entries. */
  parseGlobalMcpConfig(content: string): McpServerEntry[];
  /** Build the per-server entry to write under the config's `mcpServers` map. */
  buildGlobalMcpServerEntry(options: AddMcpServerOptions): {
    key: string;
    value: Record<string, unknown>;
  };
}

export function isGlobalMcpConfigCapable(
  adapter: ProviderAdapter,
): adapter is ProviderAdapter & GlobalMcpConfigCapability {
  return 'parseGlobalMcpConfig' in adapter && 'buildGlobalMcpServerEntry' in adapter;
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
