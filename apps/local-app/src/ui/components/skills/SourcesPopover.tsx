import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Settings2, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { Button } from '@/ui/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import { Separator } from '@/ui/components/ui/separator';
import { Switch } from '@/ui/components/ui/switch';
import { useToast } from '@/ui/hooks/use-toast';
import {
  addCommunitySource,
  disableSource,
  enableSource,
  fetchCommunitySources,
  fetchSources,
  removeCommunitySource,
  type CommunitySource,
  type SkillSource,
} from '@/ui/lib/skills';
import {
  AddCommunitySourceDialog,
  type AddCommunitySourceDialogSubmit,
} from './AddCommunitySourceDialog';
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
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [sourcePendingRemoval, setSourcePendingRemoval] = useState<CommunitySource | null>(null);

  const {
    data: sources,
    isLoading: sourcesLoading,
    error: sourcesError,
  } = useQuery({
    queryKey: ['skill-sources'],
    queryFn: fetchSources,
  });

  const {
    data: communitySources,
    isLoading: communitySourcesLoading,
    error: communitySourcesError,
  } = useQuery({
    queryKey: ['community-skill-sources'],
    queryFn: fetchCommunitySources,
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
        queryClient.invalidateQueries({ queryKey: ['community-skill-sources'] }),
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

  const addCommunitySourceMutation = useMutation({
    mutationFn: async (payload: AddCommunitySourceDialogSubmit) =>
      addCommunitySource({
        name: payload.name,
        url: payload.url,
        branch: payload.branch,
      }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['skill-sources'] }),
        queryClient.invalidateQueries({ queryKey: ['community-skill-sources'] }),
        queryClient.invalidateQueries({ queryKey: ['skills'] }),
      ]);

      toast({
        title: 'Community source added',
        description: `${formatSourceName(result.name)} is now available as a skill source.`,
      });
    },
    onError: (error) => {
      toast({
        title: 'Failed to add community source',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const removeCommunitySourceMutation = useMutation({
    mutationFn: async ({ sourceId }: { sourceId: string; sourceName: string }) =>
      removeCommunitySource(sourceId),
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['skill-sources'] }),
        queryClient.invalidateQueries({ queryKey: ['community-skill-sources'] }),
        queryClient.invalidateQueries({ queryKey: ['skills'] }),
      ]);

      setSourcePendingRemoval(null);
      toast({
        title: 'Community source removed',
        description: `${formatSourceName(variables.sourceName)} and its synced skills were removed.`,
      });
    },
    onError: (error) => {
      toast({
        title: 'Failed to remove community source',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const sourceMapByName = useMemo(() => {
    const entries = (sources ?? []).map((source) => [source.name, source] as const);
    return new Map(entries);
  }, [sources]);

  const communitySourceRows = useMemo(
    () =>
      (communitySources ?? []).map((communitySource) => {
        const sourceStats = sourceMapByName.get(communitySource.name);
        return {
          ...communitySource,
          enabled: sourceStats?.enabled ?? true,
          repoUrl:
            sourceStats?.repoUrl ??
            `https://github.com/${communitySource.repoOwner}/${communitySource.repoName}`,
          skillCount: sourceStats?.skillCount ?? 0,
        };
      }),
    [communitySources, sourceMapByName],
  );

  const communitySourceNameSet = useMemo(
    () => new Set(communitySourceRows.map((source) => source.name)),
    [communitySourceRows],
  );

  const builtInSources = useMemo(
    () => (sources ?? []).filter((source) => !communitySourceNameSet.has(source.name)),
    [sources, communitySourceNameSet],
  );

  const enabledCount = sources?.filter((source) => source.enabled).length ?? 0;
  const totalCount = sources?.length ?? 0;

  const renderSourceRow = (
    source: Pick<SkillSource, 'name' | 'enabled' | 'repoUrl' | 'skillCount'> & { rowKey: string },
    actionSlot?: ReactNode,
  ) => {
    const sourceDisplay = getSourceDisplay(source.name);
    const SourceIcon = sourceDisplay.icon;
    const isMutatingSource =
      toggleSourceMutation.isPending && toggleSourceMutation.variables?.sourceName === source.name;

    return (
      <div
        key={source.rowKey}
        className="flex items-center justify-between gap-3 rounded-md border px-2.5 py-2"
      >
        <div className="flex min-w-0 items-center gap-2">
          <SourceIcon
            className={`h-4 w-4 shrink-0 ${sourceDisplay.className}`}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <a
              href={source.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate text-sm font-medium hover:underline"
            >
              {formatSourceName(sourceDisplay.label)}
            </a>
            <p className="text-xs text-muted-foreground">{source.skillCount} skills</p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {actionSlot}
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
      </div>
    );
  };

  return (
    <>
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
        <PopoverContent className="w-96 p-3" align="end">
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
              <div className="space-y-3">
                <div className="space-y-1">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Built-in Sources
                  </h4>
                  <div className="space-y-2">
                    {builtInSources.map((source) =>
                      renderSourceRow({
                        ...source,
                        rowKey: `builtin-${source.name}`,
                      }),
                    )}
                  </div>
                </div>

                <Separator />

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Community Sources
                    </h4>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setIsAddDialogOpen(true)}
                      disabled={addCommunitySourceMutation.isPending}
                    >
                      Add Source
                    </Button>
                  </div>

                  {communitySourcesLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      Loading community sources...
                    </div>
                  ) : communitySourcesError ? (
                    <p className="text-sm text-destructive">
                      {communitySourcesError instanceof Error
                        ? communitySourcesError.message
                        : 'Failed to load community sources'}
                    </p>
                  ) : communitySourceRows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No community sources yet. Add a GitHub repository to get started.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {communitySourceRows.map((source) => {
                        const isRemovingSource =
                          removeCommunitySourceMutation.isPending &&
                          removeCommunitySourceMutation.variables?.sourceId === source.id;

                        return renderSourceRow(
                          {
                            name: source.name,
                            enabled: source.enabled,
                            repoUrl: source.repoUrl,
                            skillCount: source.skillCount,
                            rowKey: `community-${source.id}`,
                          },
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            disabled={isRemovingSource}
                            onClick={() => setSourcePendingRemoval(source)}
                            aria-label={`Remove ${formatSourceName(source.name)} source`}
                          >
                            {isRemovingSource ? (
                              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                            ) : (
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                            )}
                          </Button>,
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>

      <AddCommunitySourceDialog
        open={isAddDialogOpen}
        isSubmitting={addCommunitySourceMutation.isPending}
        onOpenChange={setIsAddDialogOpen}
        onSubmit={async (input) => {
          await addCommunitySourceMutation.mutateAsync(input);
        }}
      />

      <ConfirmDialog
        open={sourcePendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSourcePendingRemoval(null);
          }
        }}
        onConfirm={() => {
          if (!sourcePendingRemoval) {
            return;
          }
          removeCommunitySourceMutation.mutate({
            sourceId: sourcePendingRemoval.id,
            sourceName: sourcePendingRemoval.name,
          });
        }}
        title={`Remove ${formatSourceName(sourcePendingRemoval?.name ?? 'source')}?`}
        description="This will remove the source and delete its synced skills. This action cannot be undone."
        confirmText="Remove Source"
        variant="destructive"
        loading={removeCommunitySourceMutation.isPending}
      />
    </>
  );
}
