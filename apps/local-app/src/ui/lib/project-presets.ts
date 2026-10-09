import { queryOptions } from '@tanstack/react-query';
import type { ProjectPresetsResponse } from '@/modules/projects/dtos/project-presets.dto';
import type {
  ProjectPreset,
  PresetAgentConfig,
} from '@/modules/projects/helpers/project-presets.helpers';
import type { FetchFn } from './api-transport';
import { fetchJsonOrThrow } from './sessions';

export type { ProjectPresetsResponse, ProjectPreset as Preset, PresetAgentConfig };

export const projectPresetQueryKeys = {
  all: ['project-presets'] as const,
  project: (projectId: string | null | undefined) => ['project-presets', projectId] as const,
};

export function fetchProjectPresets(
  fetchFn: FetchFn,
  projectId: string,
): Promise<ProjectPresetsResponse> {
  return fetchJsonOrThrow(
    `/api/projects/${encodeURIComponent(projectId)}/presets`,
    {},
    'Failed to fetch presets',
    fetchFn,
  );
}

export const projectPresetQueries = {
  list: (fetchFn: FetchFn, projectId: string | null | undefined) =>
    queryOptions({
      queryKey: projectPresetQueryKeys.project(projectId),
      queryFn: () => fetchProjectPresets(fetchFn, projectId!),
    }),
};
