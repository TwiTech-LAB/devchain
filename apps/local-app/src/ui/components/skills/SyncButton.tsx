import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { useToast } from '@/ui/hooks/use-toast';
import { triggerSync, type SkillSyncResult } from '@/ui/lib/skills';
import { cn } from '@/ui/lib/utils';

export interface SyncButtonProps {
  sourceName?: string;
  className?: string;
  onSynced?: (result: SkillSyncResult) => void;
}

export function SyncButton({ sourceName, className, onSynced }: SyncButtonProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const syncMutation = useMutation({
    mutationFn: () => triggerSync(sourceName),
    onSuccess: async (result) => {
      if (result.status === 'already_running') {
        toast({
          title: 'Sync in progress',
          description: 'A skills sync is already running.',
        });
      } else {
        await queryClient.invalidateQueries({ queryKey: ['skills'] });

        toast({
          title: 'Skills sync complete',
          description: `Added: ${result.added}, Updated: ${result.updated}, Removed: ${result.removed}, Failed: ${result.failed}`,
        });
      }

      onSynced?.(result);
    },
    onError: (error) => {
      toast({
        title: 'Skills sync failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  return (
    <Button
      type="button"
      onClick={() => syncMutation.mutate()}
      disabled={syncMutation.isPending}
      className={cn('gap-2', className)}
      aria-label="Sync skills now"
    >
      {syncMutation.isPending ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
      )}
      {syncMutation.isPending ? 'Syncing...' : 'Sync Now'}
    </Button>
  );
}
