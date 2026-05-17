import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export interface SmartSuppressionConfig {
  enabled: boolean;
  windowMinutes: number;
}

interface SmartSuppressionData {
  smartSuppression: SmartSuppressionConfig | null;
}

const DEFAULT_SMART_SUPPRESSION: SmartSuppressionConfig = {
  enabled: true,
  windowMinutes: 5,
};

export function useSmartSuppression() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<SmartSuppressionData>({
    queryKey: ['cloud', 'preferences', 'smart-suppression'],
    queryFn: async () => {
      const res = await fetch('/api/cloud/preferences/smart-suppression');
      if (!res.ok) throw new Error(`smart-suppression:${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });

  const upsert = useMutation({
    mutationFn: async (args: SmartSuppressionConfig) => {
      const res = await fetch('/api/cloud/preferences/smart-suppression', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      if (!res.ok) throw new Error(`smart-suppression-upsert:${res.status}`);
    },
    onSuccess: (_, args) => {
      queryClient.setQueryData<SmartSuppressionData>(
        ['cloud', 'preferences', 'smart-suppression'],
        { smartSuppression: args },
      );
    },
  });

  return {
    smartSuppression: data?.smartSuppression ?? DEFAULT_SMART_SUPPRESSION,
    isLoading,
    upsert,
  };
}
