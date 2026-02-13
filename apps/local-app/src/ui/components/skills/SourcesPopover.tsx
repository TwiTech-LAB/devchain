import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Settings2, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { Button } from '@/ui/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import { Separator } from '@/ui/components/ui/separator';
import { Switch } from '@/ui/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { useToast } from '@/ui/hooks/use-toast';
import {
  addLocalSource,
  addCommunitySource,
  disableSource,
  disableSourceForProject,
  enableSource,
  enableSourceForProject,
  fetchLocalSources,
  fetchCommunitySources,
  fetchSources,
  removeLocalSource,
  removeCommunitySource,
  type LocalSource,
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

interface SourceRow
  extends Pick<
    SkillSource,
    'name' | 'enabled' | 'projectEnabled' | 'repoUrl' | 'folderPath' | 'skillCount' | 'kind'
  > {
  rowKey: string;
}

interface ManagedSourceRow extends SourceRow {
  id: string;
  managedKind: 'community' | 'local';
}

interface SourcePendingRemoval {
  id: string;
  name: string;
  kind: 'community' | 'local';
}

export function SourcesPopover() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedProjectId, selectedProject } = useSelectedProject();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [sourcePendingRemoval, setSourcePendingRemoval] = useState<SourcePendingRemoval | null>(
    null,
  );

  const {
    data: sources,
    isLoading: sourcesLoading,
    error: sourcesError,
  } = useQuery({
    queryKey: ['skill-sources', selectedProjectId ?? 'global'],
    queryFn: () => fetchSources(selectedProjectId),
  });

  const {
    data: communitySources,
    isLoading: communitySourcesLoading,
    error: communitySourcesError,
  } = useQuery({
    queryKey: ['community-skill-sources'],
    queryFn: fetchCommunitySources,
  });

  const {
    data: localSources,
    isLoading: localSourcesLoading,
    error: localSourcesError,
  } = useQuery({
    queryKey: ['local-skill-sources'],
    queryFn: fetchLocalSources,
  });

  const toggleGlobalSourceMutation = useMutation({
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

  const toggleProjectSourceMutation = useMutation({
    mutationFn: async ({
      sourceName,
      projectId,
      nextEnabled,
    }: {
      sourceName: string;
      projectId: string;
      nextEnabled: boolean;
    }) => {
      if (nextEnabled) {
        return enableSourceForProject(sourceName, projectId);
      }
      return disableSourceForProject(sourceName, projectId);
    },
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['skill-sources'] }),
        queryClient.invalidateQueries({ queryKey: ['skills'] }),
      ]);

      const projectLabel = selectedProject?.name ?? 'selected project';
      toast({
        title: result.projectEnabled ? 'Source enabled for project' : 'Source disabled for project',
        description: `${formatSourceName(result.name)} is now ${result.projectEnabled ? 'enabled' : 'disabled'} for ${projectLabel}.`,
      });
    },
    onError: (error) => {
      toast({
        title: 'Failed to update project source status',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const addSourceMutation = useMutation({
    mutationFn: async (payload: AddCommunitySourceDialogSubmit) => {
      if (payload.type === 'community') {
        const source = await addCommunitySource({
          name: payload.name,
          url: payload.url,
          branch: payload.branch,
        });
        return { kind: 'community' as const, source };
      }

      const source = await addLocalSource({
        name: payload.name,
        folderPath: payload.folderPath,
      });
      return { kind: 'local' as const, source };
    },
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['skill-sources'] }),
        queryClient.invalidateQueries({ queryKey: ['community-skill-sources'] }),
        queryClient.invalidateQueries({ queryKey: ['local-skill-sources'] }),
        queryClient.invalidateQueries({ queryKey: ['skills'] }),
      ]);

      toast({
        title: result.kind === 'community' ? 'Community source added' : 'Local source added',
        description: `${formatSourceName(result.source.name)} is now available as a skill source.`,
      });
    },
    onError: (error) => {
      toast({
        title: 'Failed to add source',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const removeSourceMutation = useMutation({
    mutationFn: async ({
      sourceId,
      sourceKind,
    }: {
      sourceId: string;
      sourceName: string;
      sourceKind: 'community' | 'local';
    }) => {
      if (sourceKind === 'community') {
        return removeCommunitySource(sourceId);
      }
      return removeLocalSource(sourceId);
    },
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['skill-sources'] }),
        queryClient.invalidateQueries({ queryKey: ['community-skill-sources'] }),
        queryClient.invalidateQueries({ queryKey: ['local-skill-sources'] }),
        queryClient.invalidateQueries({ queryKey: ['skills'] }),
      ]);

      setSourcePendingRemoval(null);
      toast({
        title:
          variables.sourceKind === 'community'
            ? 'Community source removed'
            : 'Local source removed',
        description: `${formatSourceName(variables.sourceName)} and its synced skills were removed.`,
      });
    },
    onError: (error) => {
      toast({
        title: 'Failed to remove source',
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
          projectEnabled: sourceStats?.projectEnabled,
          kind: sourceStats?.kind ?? 'community',
          repoUrl:
            sourceStats?.repoUrl ??
            `https://github.com/${communitySource.repoOwner}/${communitySource.repoName}`,
          folderPath: sourceStats?.folderPath,
          skillCount: sourceStats?.skillCount ?? 0,
        };
      }),
    [communitySources, sourceMapByName],
  );

  const localSourceRows = useMemo(
    () =>
      (localSources ?? []).map((localSource: LocalSource) => {
        const sourceStats = sourceMapByName.get(localSource.name);
        return {
          ...localSource,
          enabled: sourceStats?.enabled ?? true,
          projectEnabled: sourceStats?.projectEnabled,
          kind: sourceStats?.kind ?? 'local',
          repoUrl: sourceStats?.repoUrl ?? '',
          folderPath: sourceStats?.folderPath ?? localSource.folderPath,
          skillCount: sourceStats?.skillCount ?? 0,
        };
      }),
    [localSources, sourceMapByName],
  );

  const managedSourceRows = useMemo<ManagedSourceRow[]>(() => {
    const communityRows: ManagedSourceRow[] = communitySourceRows.map((source) => ({
      id: source.id,
      managedKind: 'community',
      name: source.name,
      enabled: source.enabled,
      projectEnabled: source.projectEnabled,
      kind: source.kind,
      repoUrl: source.repoUrl,
      folderPath: source.folderPath,
      skillCount: source.skillCount,
      rowKey: `community-${source.id}`,
    }));

    const localRows: ManagedSourceRow[] = localSourceRows.map((source) => ({
      id: source.id,
      managedKind: 'local',
      name: source.name,
      enabled: source.enabled,
      projectEnabled: source.projectEnabled,
      kind: source.kind,
      repoUrl: source.repoUrl,
      folderPath: source.folderPath,
      skillCount: source.skillCount,
      rowKey: `local-${source.id}`,
    }));

    return [...communityRows, ...localRows].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }, [communitySourceRows, localSourceRows]);

  const builtinSources = useMemo(
    () => (sources ?? []).filter((source) => source.kind === 'builtin'),
    [sources],
  );

  const enabledCount =
    selectedProjectId && sources
      ? sources.filter((source) => source.projectEnabled ?? source.enabled).length
      : (sources?.filter((source) => source.enabled).length ?? 0);
  const totalCount = sources?.length ?? 0;

  const renderSourceRow = (source: SourceRow, actionSlot?: ReactNode) => {
    const sourceDisplay = getSourceDisplay(source.name, source.kind);
    const SourceIcon = sourceDisplay.icon;
    const isMutatingGlobalSource =
      toggleGlobalSourceMutation.isPending &&
      toggleGlobalSourceMutation.variables?.sourceName === source.name;
    const isMutatingProjectSource =
      toggleProjectSourceMutation.isPending &&
      toggleProjectSourceMutation.variables?.sourceName === source.name;
    const projectToggleChecked = source.projectEnabled ?? source.enabled;
    const projectToggleDisabled = !source.enabled || isMutatingProjectSource;
    const projectNameLabel = selectedProject?.name ?? 'selected project';
    const sourceLocation =
      source.kind === 'local' ? (source.folderPath ?? source.repoUrl) : source.repoUrl;
    const displayName = formatSourceName(sourceDisplay.label);

    return (
      <div key={source.rowKey} className="flex items-center gap-3 rounded-md border px-2.5 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <SourceIcon
            className={`h-4 w-4 shrink-0 ${sourceDisplay.className}`}
            aria-hidden="true"
          />
          <div className="min-w-0">
            {source.kind === 'local' ? (
              <p className="truncate text-sm font-medium" title={displayName}>
                {displayName}
              </p>
            ) : (
              <a
                href={source.repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block max-w-full truncate text-sm font-medium hover:underline"
                title={displayName}
              >
                {displayName}
              </a>
            )}
            {source.kind === 'local' ? (
              <p className="truncate text-xs text-muted-foreground" title={sourceLocation}>
                {sourceLocation}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">{source.skillCount} skills</p>
          </div>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {actionSlot}
          {selectedProjectId ? (
            <>
              <div className="flex items-center gap-1 rounded border px-1.5 py-1">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Global
                </span>
                <Switch
                  checked={source.enabled}
                  disabled={isMutatingGlobalSource}
                  onCheckedChange={(checked) =>
                    toggleGlobalSourceMutation.mutate({
                      sourceName: source.name,
                      nextEnabled: checked,
                    })
                  }
                  aria-label={`Enable or disable ${formatSourceName(source.name)} globally`}
                />
              </div>
              <div
                className={`flex items-center gap-1 rounded border px-1.5 py-1 ${
                  !source.enabled ? 'opacity-60' : ''
                }`}
              >
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Project
                </span>
                {source.enabled ? (
                  <Switch
                    checked={projectToggleChecked}
                    disabled={projectToggleDisabled}
                    onCheckedChange={(checked) =>
                      selectedProjectId
                        ? toggleProjectSourceMutation.mutate({
                            sourceName: source.name,
                            projectId: selectedProjectId,
                            nextEnabled: checked,
                          })
                        : undefined
                    }
                    aria-label={`Enable or disable ${formatSourceName(source.name)} for ${projectNameLabel}`}
                  />
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Switch
                          checked={false}
                          disabled
                          aria-label={`${formatSourceName(source.name)} is disabled globally`}
                        />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Disabled globally</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </>
          ) : (
            <Switch
              checked={source.enabled}
              disabled={isMutatingGlobalSource}
              onCheckedChange={(checked) =>
                toggleGlobalSourceMutation.mutate({
                  sourceName: source.name,
                  nextEnabled: checked,
                })
              }
              aria-label={`Enable or disable ${formatSourceName(source.name)} source`}
            />
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <TooltipProvider>
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
                  {selectedProject
                    ? `Source settings for ${selectedProject.name}. Global switches still apply across all projects.`
                    : 'Enable or disable sources globally across all projects.'}
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
                      {builtinSources.map((source) =>
                        renderSourceRow({
                          ...source,
                          rowKey: `core-${source.name}`,
                        }),
                      )}
                    </div>
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Community & Local Sources
                      </h4>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setIsAddDialogOpen(true)}
                        disabled={addSourceMutation.isPending}
                      >
                        Add Source
                      </Button>
                    </div>

                    {communitySourcesLoading || localSourcesLoading ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        Loading managed sources...
                      </div>
                    ) : communitySourcesError || localSourcesError ? (
                      <p className="text-sm text-destructive">
                        {communitySourcesError instanceof Error
                          ? communitySourcesError.message
                          : localSourcesError instanceof Error
                            ? localSourcesError.message
                            : 'Failed to load managed sources'}
                      </p>
                    ) : managedSourceRows.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No managed sources yet. Add a GitHub repository or local folder to get
                        started.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {managedSourceRows.map((source) => {
                          const isRemovingSource =
                            removeSourceMutation.isPending &&
                            removeSourceMutation.variables?.sourceId === source.id;

                          return renderSourceRow(
                            {
                              name: source.name,
                              enabled: source.enabled,
                              projectEnabled: source.projectEnabled,
                              kind: source.kind,
                              repoUrl: source.repoUrl,
                              folderPath: source.folderPath,
                              skillCount: source.skillCount,
                              rowKey: source.rowKey,
                            },
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              disabled={isRemovingSource}
                              onClick={() =>
                                setSourcePendingRemoval({
                                  id: source.id,
                                  name: source.name,
                                  kind: source.managedKind,
                                })
                              }
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
      </TooltipProvider>

      <AddCommunitySourceDialog
        open={isAddDialogOpen}
        isSubmitting={addSourceMutation.isPending}
        onOpenChange={setIsAddDialogOpen}
        onSubmit={async (input) => {
          await addSourceMutation.mutateAsync(input);
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
          removeSourceMutation.mutate({
            sourceId: sourcePendingRemoval.id,
            sourceName: sourcePendingRemoval.name,
            sourceKind: sourcePendingRemoval.kind,
          });
        }}
        title={`Remove ${formatSourceName(sourcePendingRemoval?.name ?? 'source')}?`}
        description="This will remove the source and delete its synced skills. This action cannot be undone."
        confirmText="Remove Source"
        variant="destructive"
        loading={removeSourceMutation.isPending}
      />
    </>
  );
}
