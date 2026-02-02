/**
 * Preset validation utilities for config switcher functionality.
 */

export interface Preset {
  name: string;
  description?: string | null;
  agentConfigs: Array<{
    agentName: string;
    providerConfigName: string;
  }>;
}

export interface Agent {
  id: string;
  name: string;
  profileId: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  profileId: string;
  providerId: string;
}

export interface PresetAvailability {
  preset: Preset;
  available: boolean;
  missingConfigs: Array<{
    agentName: string;
    configName: string;
    reason: 'agent_not_found' | 'config_not_found';
  }>;
}

/**
 * Validate preset availability client-side.
 *
 * Checks if all agents and provider configs referenced by a preset exist.
 * Uses case-insensitive, trimmed name matching (same as backend).
 *
 * @param preset - The preset to validate
 * @param agents - Array of agents in the project
 * @param configsByProfile - Map of profileId to available provider configs
 * @returns PresetAvailability with available status and missing configs
 */
export function validatePresetAvailability(
  preset: Preset,
  agents: Agent[],
  configsByProfile: Map<string, ProviderConfig[]>,
): PresetAvailability {
  const missing: PresetAvailability['missingConfigs'] = [];

  for (const ac of preset.agentConfigs) {
    // Match agent by name (case-insensitive, trimmed) - same as backend
    const agent = agents.find(
      (a) => a.name.trim().toLowerCase() === ac.agentName.trim().toLowerCase(),
    );

    if (!agent) {
      missing.push({
        agentName: ac.agentName,
        configName: ac.providerConfigName,
        reason: 'agent_not_found',
      });
      continue;
    }

    // Check config exists in agent's profile
    const configs = configsByProfile.get(agent.profileId) ?? [];
    const configExists = configs.some(
      (c) => c.name.trim().toLowerCase() === ac.providerConfigName.trim().toLowerCase(),
    );

    if (!configExists) {
      missing.push({
        agentName: ac.agentName,
        configName: ac.providerConfigName,
        reason: 'config_not_found',
      });
    }
  }

  return { preset, available: missing.length === 0, missingConfigs: missing };
}
