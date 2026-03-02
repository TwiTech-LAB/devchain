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
