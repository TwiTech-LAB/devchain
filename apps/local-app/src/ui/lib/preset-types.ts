export interface PresetAgentConfig {
  agentName: string;
  providerConfigName: string;
  modelOverride?: string | null;
}

export interface Preset {
  name: string;
  description?: string | null;
  agentConfigs: PresetAgentConfig[];
}

export interface RenameProviderConfigPresetAgentContext {
  name: string;
  profileId: string;
}

export interface RenameProviderConfigInProjectPresetsInput {
  profileId: string;
  oldName: string;
  newName: string;
  agents: RenameProviderConfigPresetAgentContext[];
}
