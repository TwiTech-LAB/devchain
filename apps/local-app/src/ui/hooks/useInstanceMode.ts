import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export type InstanceMode = 'local' | 'cloud';

interface Settings {
  instanceMode?: InstanceMode;
  apiKey?: string;
}

async function fetchSettings(): Promise<Settings> {
  const response = await fetch('/api/settings');
  if (!response.ok) {
    throw new Error('Failed to fetch settings');
  }
  return response.json();
}

async function updateSettings(settings: Settings): Promise<Settings> {
  const response = await fetch('/api/settings', {
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
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
  });

  const mutation = useMutation({
    mutationFn: updateSettings,
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
