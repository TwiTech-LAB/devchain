import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { useToast } from '@/ui/hooks/use-toast';
import { triggerSync, type SkillSyncError, type SkillSyncResult } from '@/ui/lib/skills';
import { cn } from '@/ui/lib/utils';

export interface SyncButtonProps {
  sourceName?: string;
  className?: string;
  onSynced?: (result: SkillSyncResult) => void;
}

const MAX_REPORTED_ERRORS = 3;

/**
 * One line per distinct error message with the sources that hit it, so a
 * shared cause such as a GitHub rate limit reads once instead of per source.
 */
function describeSyncErrors(errors: SkillSyncError[]): string {
  const sourcesByMessage = new Map<string, Set<string>>();
  for (const error of errors) {
    const sources = sourcesByMessage.get(error.message) ?? new Set<string>();
    sources.add(error.sourceName);
    sourcesByMessage.set(error.message, sources);
  }
  const lines = [...sourcesByMessage.entries()]
    .slice(0, MAX_REPORTED_ERRORS)
    .map(([message, sources]) => `${[...sources].join(', ')}: ${message}`);
  return lines.join(' ');
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

        const summary = `Added: ${result.added}, Updated: ${result.updated}, Removed: ${result.removed}, Failed: ${result.failed}`;
        toast({
          title: 'Skills sync complete',
          description:
            result.errors.length > 0 ? `${summary}. ${describeSyncErrors(result.errors)}` : summary,
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
