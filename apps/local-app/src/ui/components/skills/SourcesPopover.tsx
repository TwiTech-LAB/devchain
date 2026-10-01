import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Settings2, Trash2 } from 'lucide-react';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
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
import { HOME_BACKEND } from '@/ui/lib/api-transport';
import { useOptionalBackend } from '@/ui/lib/backend-context';
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
  type ExistingProjectsChoice,
  type LocalSource,
  type SkillSource,
} from '@/ui/lib/skills';
import {
  AddCommunitySourceDialog,
  type AddCommunitySourceDialogSubmit,
} from './AddCommunitySourceDialog';
import { getSourceDisplay } from './source-display';
import { AlwaysOnSwitch } from './AlwaysOnSwitch';
import { isAlwaysEnabledSkillSource } from '@/common/constants/built-in-skill-sources';
import { useFetchFactory, useHomeFetch } from '@/ui/hooks/useFetchFactory';

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
  /** False only for a remote project whose host does not list the source yet. */
  onHost: boolean;
  /** The host lists this source and home does not; only the Project switch applies. */
  hostOnly?: boolean;
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

function describeExistingProjectsChoice(
  choice: ExistingProjectsChoice,
  selectedProjectName: string,
): string {
  switch (choice.mode) {
    case 'all':
      return 'Enabled in all existing projects';
    case 'selected':
      return `Enabled in ${selectedProjectName}`;
    case 'none':
      return 'Disabled in existing projects';
  }
}

// Matches the remotes health poll that pushes global skill settings to a host,
// so a source added at home appears on the host within about one interval.
const HOST_SOURCES_REFETCH_MS = 10_000;

export function SourcesPopover() {
  const fetchFn = useFetchFactory();
  const homeFetch = useHomeFetch();
  const queryClient = useQueryClient();
  const homeClient = useHomeQueryClient();
  const { toast } = useToast();
  const { selectedProjectId, selectedProject } = useSelectedProject();
  const isRemoteProject = useOptionalBackend()?.activeRemote != null;
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [sourcePendingRemoval, setSourcePendingRemoval] = useState<SourcePendingRemoval | null>(
    null,
  );

  // Home owns global skill settings: for a remote project this query is the
  // source of truth for every `enabled` switch; with a home (or no) project it
  // stays disabled and the project-scoped query below carries both halves.
  const { data: homeSources } = useQuery(
    {
      queryKey: [HOME_BACKEND, 'skill-sources', 'global'],
      queryFn: () => fetchSources(homeFetch),
      enabled: isRemoteProject,
    },
    homeClient,
  );

  const {
    data: sources,
    isLoading: sourcesLoading,
    error: sourcesError,
  } = useQuery({
    queryKey: ['skill-sources', selectedProjectId ?? 'global'],
    queryFn: () => fetchSources(fetchFn, selectedProjectId),
    refetchInterval: isRemoteProject && isPopoverOpen ? HOST_SOURCES_REFETCH_MS : false,
  });

  const {
    data: communitySources,
    isLoading: communitySourcesLoading,
    error: communitySourcesError,
  } = useQuery(
    {
      queryKey: [HOME_BACKEND, 'community-skill-sources'],
      queryFn: () => fetchCommunitySources(homeFetch),
    },
    homeClient,
  );

  const {
    data: localSources,
    isLoading: localSourcesLoading,
    error: localSourcesError,
  } = useQuery(
    {
      queryKey: [HOME_BACKEND, 'local-skill-sources'],
      queryFn: () => fetchLocalSources(homeFetch),
    },
    homeClient,
  );

  // A pushed global change lands on the host asynchronously; when the open
  // popover's host refetch reports it, the mounted skill list must not stay
  // stale, so any availability, enablement or count change refreshes it.
  const previousHostStateRef = useRef<{ projectId: string; signature: string } | null>(null);
  useEffect(() => {
    if (!isRemoteProject || !selectedProjectId || !sources) {
      return;
    }
    const signature = sources
      .map(
        (source) =>
          `${source.name}:${source.enabled ? 1 : 0}:${
            source.projectEnabled === undefined ? '' : source.projectEnabled ? 1 : 0
          }:${source.skillCount}`,
      )
      .sort()
      .join('|');
    const previous = previousHostStateRef.current;
    if (previous?.projectId === selectedProjectId && previous.signature !== signature) {
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
    }
    previousHostStateRef.current = { projectId: selectedProjectId, signature };
  }, [isRemoteProject, queryClient, selectedProjectId, sources]);

  // Global source changes live at home; the selected project's backend caches
  // the merged source list, and a home project also caches its skill list.
  const invalidateSourceQueries = async (withSourceLists: boolean): Promise<void> => {
    await Promise.all([
      homeClient.invalidateQueries({ queryKey: [HOME_BACKEND, 'skill-sources'] }),
      ...(withSourceLists
        ? [
            homeClient.invalidateQueries({ queryKey: [HOME_BACKEND, 'community-skill-sources'] }),
            homeClient.invalidateQueries({ queryKey: [HOME_BACKEND, 'local-skill-sources'] }),
          ]
        : []),
      queryClient.invalidateQueries({ queryKey: ['skill-sources'] }),
    ]);
    if (!isRemoteProject) {
      await queryClient.invalidateQueries({ queryKey: ['skills'] });
    }
  };

  const toggleGlobalSourceMutation = useMutation(
    {
      mutationFn: async ({
        sourceName,
        nextEnabled,
      }: {
        sourceName: string;
        nextEnabled: boolean;
      }) => {
        if (nextEnabled) {
          return enableSource(homeFetch, sourceName);
        }
        return disableSource(homeFetch, sourceName);
      },
      onSuccess: async (result) => {
        await invalidateSourceQueries(false);

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
    },
    homeClient,
  );

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
        return enableSourceForProject(fetchFn, sourceName, projectId);
      }
      return disableSourceForProject(fetchFn, sourceName, projectId);
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

  const addSourceMutation = useMutation(
    {
      mutationFn: async (payload: AddCommunitySourceDialogSubmit) => {
        if (payload.type === 'community') {
          const source = await addCommunitySource(homeFetch, {
            name: payload.name,
            url: payload.url,
            branch: payload.branch,
            existingProjects: payload.existingProjects,
          });
          return {
            kind: 'community' as const,
            source,
            existingProjects: payload.existingProjects,
          };
        }

        const source = await addLocalSource(homeFetch, {
          name: payload.name,
          folderPath: payload.folderPath,
          existingProjects: payload.existingProjects,
        });
        return { kind: 'local' as const, source, existingProjects: payload.existingProjects };
      },
      onSuccess: async (result) => {
        await invalidateSourceQueries(true);

        const choice = describeExistingProjectsChoice(
          result.existingProjects,
          selectedProject?.name ?? 'selected project',
        );

        toast({
          title: result.kind === 'community' ? 'Community source added' : 'Local source added',
          description: `${formatSourceName(result.source.name)} is now available as a skill source. ${choice}.`,
        });
      },
      onError: (error) => {
        toast({
          title: 'Failed to add source',
          description: error instanceof Error ? error.message : 'Unknown error',
          variant: 'destructive',
        });
      },
    },
    homeClient,
  );

  const removeSourceMutation = useMutation(
    {
      mutationFn: async ({
        sourceId,
        sourceKind,
      }: {
        sourceId: string;
        sourceName: string;
        sourceKind: 'community' | 'local';
      }) => {
        if (sourceKind === 'community') {
          return removeCommunitySource(homeFetch, sourceId);
        }
        return removeLocalSource(homeFetch, sourceId);
      },
      onSuccess: async (_result, variables) => {
        await invalidateSourceQueries(true);

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
    },
    homeClient,
  );

  // Global state (enabled, definition) comes from home; per-project state and
  // counts come from the host that owns the project. With a home (or no)
  // project both maps are built from the same single query.
  const globalSources = isRemoteProject ? homeSources : sources;
  const globalStatsByName = useMemo(() => {
    const entries = (globalSources ?? []).map((source) => [source.name, source] as const);
    return new Map(entries);
  }, [globalSources]);
  const hostStatsByName = useMemo(() => {
    const entries = (sources ?? []).map((source) => [source.name, source] as const);
    return new Map(entries);
  }, [sources]);

  const communitySourceRows = useMemo(
    () =>
      (communitySources ?? []).map((communitySource) => {
        const sourceStats = globalStatsByName.get(communitySource.name);
        const hostStats = hostStatsByName.get(communitySource.name);
        return {
          ...communitySource,
          enabled: sourceStats?.enabled ?? true,
          projectEnabled: hostStats?.projectEnabled,
          kind: sourceStats?.kind ?? 'community',
          repoUrl:
            sourceStats?.repoUrl ??
            `https://github.com/${communitySource.repoOwner}/${communitySource.repoName}`,
          folderPath: sourceStats?.folderPath,
          skillCount: hostStats?.skillCount ?? 0,
          onHost: !isRemoteProject || hostStats !== undefined,
        };
      }),
    [communitySources, globalStatsByName, hostStatsByName, isRemoteProject],
  );

  const localSourceRows = useMemo(
    () =>
      (localSources ?? []).map((localSource: LocalSource) => {
        const sourceStats = globalStatsByName.get(localSource.name);
        const hostStats = hostStatsByName.get(localSource.name);
        return {
          ...localSource,
          enabled: sourceStats?.enabled ?? true,
          projectEnabled: hostStats?.projectEnabled,
          kind: sourceStats?.kind ?? 'local',
          repoUrl: sourceStats?.repoUrl ?? '',
          folderPath: sourceStats?.folderPath ?? localSource.folderPath,
          skillCount: hostStats?.skillCount ?? 0,
          onHost: !isRemoteProject || hostStats !== undefined,
        };
      }),
    [localSources, globalStatsByName, hostStatsByName, isRemoteProject],
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
      onHost: source.onHost,
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
      onHost: source.onHost,
      rowKey: `local-${source.id}`,
    }));

    return [...communityRows, ...localRows].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }, [communitySourceRows, localSourceRows]);

  // A source only the VM has is retained there: home cannot manage it
  // globally, but the selected project still needs its per-project switch.
  // Computed only once home's own list has loaded, so a loading home query
  // cannot mark every host source as VM-only.
  const hostOnlySourceRows = useMemo<SourceRow[]>(() => {
    if (!isRemoteProject || !selectedProjectId || !homeSources) return [];
    // With a remote active, the global map holds exactly home's sources.
    return (sources ?? [])
      .filter((source) => !globalStatsByName.has(source.name))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((source) => ({
        ...source,
        onHost: true,
        hostOnly: true,
        rowKey: `host-only-${source.name}`,
      }));
  }, [globalStatsByName, homeSources, isRemoteProject, selectedProjectId, sources]);

  const builtinSourceRows = useMemo(
    () =>
      (globalSources ?? [])
        .filter((source) => source.kind === 'builtin')
        .map((source) => {
          if (!isRemoteProject) {
            return { ...source, onHost: true };
          }
          const hostStats = hostStatsByName.get(source.name);
          return {
            ...source,
            projectEnabled: hostStats?.projectEnabled,
            skillCount: hostStats?.skillCount ?? 0,
            onHost: hostStats !== undefined,
          };
        }),
    [globalSources, hostStatsByName, isRemoteProject],
  );

  const enabledCount = useMemo(() => {
    const rows = [...builtinSourceRows, ...managedSourceRows, ...hostOnlySourceRows];
    return selectedProjectId
      ? rows.filter((source) => source.projectEnabled ?? source.enabled).length
      : rows.filter((source) => source.enabled).length;
  }, [builtinSourceRows, hostOnlySourceRows, managedSourceRows, selectedProjectId]);
  const totalCount =
    builtinSourceRows.length + managedSourceRows.length + hostOnlySourceRows.length;

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
    const alwaysOn = isAlwaysEnabledSkillSource(source.name);

    const renderGlobalSwitch = (ariaLabel: string, alwaysOnLabel: string) =>
      alwaysOn ? (
        <AlwaysOnSwitch label={alwaysOnLabel} />
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
          aria-label={ariaLabel}
        />
      );

    const renderProjectSwitch = () => {
      if (alwaysOn) {
        return (
          <AlwaysOnSwitch
            label={`${formatSourceName(source.name)} is always on for ${projectNameLabel}`}
          />
        );
      }
      if (!source.enabled) {
        return (
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
        );
      }
      return (
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
      );
    };

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
            {source.hostOnly ? (
              <p className="text-xs text-muted-foreground">Only on this VM</p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {source.onHost ? `${source.skillCount} skills` : 'Not on this host'}
            </p>
          </div>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {actionSlot}
          {selectedProjectId ? (
            <>
              {!source.hostOnly ? (
                <div className="flex items-center gap-1 rounded border px-1.5 py-1">
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Global
                  </span>
                  {renderGlobalSwitch(
                    `Enable or disable ${formatSourceName(source.name)} globally`,
                    `${formatSourceName(source.name)} is always on globally`,
                  )}
                </div>
              ) : null}
              <div
                className={`flex items-center gap-1 rounded border px-1.5 py-1 ${
                  !source.enabled && !alwaysOn ? 'opacity-60' : ''
                }`}
              >
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Project
                </span>
                {renderProjectSwitch()}
              </div>
            </>
          ) : (
            renderGlobalSwitch(
              `Enable or disable ${formatSourceName(source.name)} source`,
              `${formatSourceName(source.name)} source is always on`,
            )
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <TooltipProvider>
        <Popover open={isPopoverOpen} onOpenChange={setIsPopoverOpen}>
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
                {isRemoteProject ? (
                  <p className="text-xs text-muted-foreground">
                    Global changes are saved on this PC and reach the host within about 10 seconds.
                  </p>
                ) : null}
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
              ) : (globalSources?.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">No skill sources registered.</p>
              ) : (
                <div className="space-y-3">
                  <div className="space-y-1">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Built-in Sources
                    </h4>
                    <div className="space-y-2">
                      {builtinSourceRows.map((source) =>
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
                    ) : managedSourceRows.length + hostOnlySourceRows.length === 0 ? (
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
                              onHost: source.onHost,
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
                        {hostOnlySourceRows.map((source) => renderSourceRow(source))}
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
        currentProject={
          selectedProjectId && selectedProject
            ? { id: selectedProjectId, name: selectedProject.name }
            : null
        }
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
