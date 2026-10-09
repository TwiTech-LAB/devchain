export type { Preset, PresetAgentConfig } from './project-presets';

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
