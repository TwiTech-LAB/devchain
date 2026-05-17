import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export interface QuietHours {
  enabled: boolean;
  startMinutes: number;
  endMinutes: number;
  timezone: string;
}

interface QuietHoursData {
  quietHours: QuietHours | null;
}

export function useQuietHours() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<QuietHoursData>({
    queryKey: ['cloud', 'preferences', 'quiet-hours'],
    queryFn: async () => {
      const res = await fetch('/api/cloud/preferences/quiet-hours');
      if (!res.ok) throw new Error(`quiet-hours:${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });

  const upsert = useMutation({
    mutationFn: async (args: QuietHours) => {
      const res = await fetch('/api/cloud/preferences/quiet-hours', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      if (!res.ok) throw new Error(`quiet-hours-upsert:${res.status}`);
    },
    onSuccess: (_, args) => {
      queryClient.setQueryData<QuietHoursData>(['cloud', 'preferences', 'quiet-hours'], {
        quietHours: args,
      });
    },
  });

  return { quietHours: data?.quietHours ?? null, isLoading, upsert };
}
