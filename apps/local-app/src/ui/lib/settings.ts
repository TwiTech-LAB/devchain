import { queryOptions } from '@tanstack/react-query';
import type { SettingsDto } from '@/modules/settings/dtos/settings.dto';
import type { FetchFn } from './api-transport';
import { fetchJsonOrThrow } from './sessions';

export type { SettingsDto };

export const settingsQueryKeys = {
  all: ['settings'] as const,
};

export function fetchSettings(fetchFn: FetchFn): Promise<SettingsDto> {
  return fetchJsonOrThrow('/api/settings', {}, 'Failed to fetch settings', fetchFn);
}

export const settingsQueries = {
  get: (fetchFn: FetchFn) =>
    queryOptions({
      queryKey: settingsQueryKeys.all,
      queryFn: () => fetchSettings(fetchFn),
    }),
};
