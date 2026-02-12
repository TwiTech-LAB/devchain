import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Settings2 } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import { Switch } from '@/ui/components/ui/switch';
import { useToast } from '@/ui/hooks/use-toast';
import { disableSource, enableSource, fetchSources } from '@/ui/lib/skills';
import { getSourceDisplay } from './source-display';

function formatSourceName(name: string): string {
  if (!name) {
    return 'Unknown';
  }
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function SourcesPopover() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const {
    data: sources,
    isLoading: sourcesLoading,
    error: sourcesError,
  } = useQuery({
    queryKey: ['skill-sources'],
    queryFn: fetchSources,
  });

  const toggleSourceMutation = useMutation({
    mutationFn: async ({
      sourceName,
      nextEnabled,
    }: {
      sourceName: string;
      nextEnabled: boolean;
    }) => {
      if (nextEnabled) {
        return enableSource(sourceName);
      }
      return disableSource(sourceName);
    },
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['skill-sources'] }),
        queryClient.invalidateQueries({ queryKey: ['skills'] }),
      ]);

      toast({
        title: result.enabled ? 'Source enabled' : 'Source disabled',
        description: `${formatSourceName(result.name)} skills are now ${result.enabled ? 'visible' : 'hidden'}.`,
      });
    },
    onError: (error) => {
      toast({
        title: 'Failed to update source status',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const enabledCount = sources?.filter((source) => source.enabled).length ?? 0;
  const totalCount = sources?.length ?? 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="gap-2">
          {sourcesLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Settings2 className="h-4 w-4" aria-hidden="true" />
          )}
          {`Sources (${enabledCount}/${totalCount})`}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3" align="end">
        <div className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Skill Sources</h3>
            <p className="text-xs text-muted-foreground">
              Enable or disable sources globally across all projects.
            </p>
          </div>

          {sourcesLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Loading source settings...
            </div>
          ) : sourcesError ? (
            <p className="text-sm text-destructive">
              {sourcesError instanceof Error
                ? sourcesError.message
                : 'Failed to load source settings'}
            </p>
          ) : (sources?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No skill sources registered.</p>
          ) : (
            <div className="space-y-2">
              {sources?.map((source) => {
                const sourceDisplay = getSourceDisplay(source.name);
                const SourceIcon = sourceDisplay.icon;
                const isMutatingSource =
                  toggleSourceMutation.isPending &&
                  toggleSourceMutation.variables?.sourceName === source.name;

                return (
                  <div
                    key={source.name}
                    className="flex items-center justify-between gap-3 rounded-md border px-2.5 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <SourceIcon
                        className={`h-4 w-4 shrink-0 ${sourceDisplay.className}`}
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {formatSourceName(sourceDisplay.label)}
                        </p>
                        <p className="text-xs text-muted-foreground">{source.skillCount} skills</p>
                      </div>
                    </div>
                    <Switch
                      checked={source.enabled}
                      disabled={isMutatingSource}
                      onCheckedChange={(checked) =>
                        toggleSourceMutation.mutate({
                          sourceName: source.name,
                          nextEnabled: checked,
                        })
                      }
                      aria-label={`Enable or disable ${formatSourceName(source.name)} source`}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
