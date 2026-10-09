import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsQueries, settingsQueryKeys, type SettingsDto } from '@/ui/lib/settings';
import type { FetchFn } from '@/ui/lib/api-transport';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';

export type InstanceMode = 'local' | 'cloud';

async function updateSettings(
  fetchFn: FetchFn,
  settings: { instanceMode: InstanceMode; apiKey?: string },
): Promise<SettingsDto> {
  const response = await fetchFn('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!response.ok) {
    throw new Error('Failed to update settings');
  }
  return response.json();
}

export function useInstanceMode() {
  const fetchFn = useFetchFactory();
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery(settingsQueries.get(fetchFn));

  const mutation = useMutation({
    mutationFn: (settings: Parameters<typeof updateSettings>[1]) =>
      updateSettings(fetchFn, settings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: settingsQueryKeys.all });
    },
  });

  const instanceMode =
    settings &&
    'instanceMode' in settings &&
    (settings.instanceMode === 'local' || settings.instanceMode === 'cloud')
      ? settings.instanceMode
      : undefined;
  const apiKey =
    settings && 'apiKey' in settings && typeof settings.apiKey === 'string'
      ? settings.apiKey
      : undefined;

  return {
    instanceMode,
    apiKey,
    isLoading,
    setInstanceMode: (mode: InstanceMode, apiKey?: string) => {
      mutation.mutate({ instanceMode: mode, apiKey });
    },
  };
}
