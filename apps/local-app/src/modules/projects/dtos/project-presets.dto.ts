import type { ProjectPreset } from '../helpers/project-presets.helpers';

export interface ProjectPresetsResponse {
  presets: ProjectPreset[];
  activePreset: string | null;
}
