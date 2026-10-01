import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { FetchFn } from '@/ui/lib/api-transport';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';

export type InstanceMode = 'local' | 'cloud';

interface Settings {
  instanceMode?: InstanceMode;
  apiKey?: string;
}

async function fetchSettings(fetchFn: FetchFn): Promise<Settings> {
  const response = await fetchFn('/api/settings');
  if (!response.ok) {
    throw new Error('Failed to fetch settings');
  }
  return response.json();
}

async function updateSettings(fetchFn: FetchFn, settings: Settings): Promise<Settings> {
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

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => fetchSettings(fetchFn),
  });

  const mutation = useMutation({
    mutationFn: (settings: Settings) => updateSettings(fetchFn, settings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  return {
    instanceMode: settings?.instanceMode,
    apiKey: settings?.apiKey,
    isLoading,
    setInstanceMode: (mode: InstanceMode, apiKey?: string) => {
      mutation.mutate({ instanceMode: mode, apiKey });
    },
  };
}
