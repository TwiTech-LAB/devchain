import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Folder } from 'lucide-react';
import { Switch } from '../ui/switch';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';
import { useDevicesQuery } from '@/ui/hooks/useDevicesQuery';

interface ProjectForwardingRowProps {
  projectId: string;
  projectName: string;
  rootPath: string;
  bulkPending: boolean;
}

export function ProjectForwardingRow({
  projectId,
  projectName,
  rootPath,
  bulkPending,
}: ProjectForwardingRowProps) {
  const queryClient = useQueryClient();
  const devicesState = useDevicesQuery();
  const showTooltip = devicesState.status === 'ready' && devicesState.devices.length === 0;

  const { data, isLoading } = useQuery<{ enabled: boolean }>({
    queryKey: ['cloud', 'egress', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/cloud/egress/projects/${projectId}`);
      if (!res.ok) throw new Error('Failed to fetch egress config');
      return res.json();
    },
  });

  const mutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await fetch(`/api/cloud/egress/projects/${projectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error('Failed to update egress config');
      return res.json() as Promise<{ enabled: boolean }>;
    },
    onSuccess: (result) => {
      queryClient.setQueryData(['cloud', 'egress', projectId], result);
    },
  });

  const enabled = data?.enabled ?? false;
  const switchEl = (
    <Switch
      checked={enabled}
      disabled={isLoading || mutation.isPending || bulkPending}
      onCheckedChange={(checked) => mutation.mutate(checked)}
      aria-label={`Push notifications for ${projectName}`}
    />
  );

  return (
    <div className="flex items-center justify-between gap-3 rounded-md px-3 py-2 transition-colors hover:bg-muted/50">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <Folder className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{projectName}</div>
          <div className="truncate text-xs text-muted-foreground" title={rootPath}>
            {rootPath}
          </div>
        </div>
      </div>
      <div className="ml-2 shrink-0">
        {showTooltip ? (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>{switchEl}</TooltipTrigger>
              <TooltipContent>No device will receive these notifications yet.</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          switchEl
        )}
      </div>
    </div>
  );
}
