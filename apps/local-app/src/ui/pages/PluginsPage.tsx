import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Loader2, RefreshCw, Search } from 'lucide-react';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Switch } from '@/ui/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/components/ui/table';
import { useCrudMutation } from '@/ui/hooks/useCrudMutations';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import {
  fetchProviderPluginPolicies,
  fetchProviderPlugins,
  refreshProviderPlugins,
  resetProjectProviderPluginPolicy,
  resetProviderPluginDefault,
  setProjectProviderPluginPolicy,
  setProviderPluginDefault,
  type ProviderPlugin,
  type ProviderPluginPolicy,
  type ProviderPluginPolicySource,
} from '@/ui/lib/provider-plugins';
import { getErrorMessage, useToastHelpers } from '@/ui/lib/toast-helpers';
import { cn } from '@/ui/lib/utils';

type StatusFilter = 'all' | 'installed' | 'available';
type PolicyScope = ProviderPluginPolicySource;

interface PolicyMutationVariables {
  scope: PolicyScope;
  plugin: ProviderPlugin;
  enabled?: boolean;
  reset?: boolean;
}

const providerPluginsKey = ['provider-plugins'] as const;

function providerPluginPoliciesKey(projectId: string | undefined) {
  return ['provider-plugin-policies', projectId ?? null] as const;
}

function policyKey(providerId: string, pluginId: string, source: PolicyScope): string {
  return `${source}:${providerId}:${pluginId}`;
}

function getDefaultEnabled(
  plugin: ProviderPlugin,
  defaultPolicy: ProviderPluginPolicy | undefined,
): boolean {
  return defaultPolicy?.enabled ?? plugin.providerEnabled;
}

function getProjectEnabled(
  plugin: ProviderPlugin,
  projectPolicy: ProviderPluginPolicy | undefined,
  defaultPolicy: ProviderPluginPolicy | undefined,
): boolean {
  return projectPolicy?.enabled ?? getDefaultEnabled(plugin, defaultPolicy);
}

function getSearchValue(plugin: ProviderPlugin): string {
  return [
    plugin.name,
    plugin.pluginId,
    plugin.description,
    plugin.marketplaceName,
    plugin.providerName,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();
}

function PolicyControl({
  plugin,
  source,
  policy,
  effectiveEnabled,
  pending,
  failed,
  onChange,
  onReset,
}: {
  plugin: ProviderPlugin;
  source: PolicyScope;
  policy?: ProviderPluginPolicy;
  effectiveEnabled: boolean;
  pending: boolean;
  failed: boolean;
  onChange: (enabled: boolean) => void;
  onReset: () => void;
}) {
  const sourceLabel = source === 'default' ? 'DevChain Default' : 'This Project';

  return (
    <div className="flex min-w-[150px] items-center gap-2">
      <Switch
        checked={effectiveEnabled}
        onCheckedChange={onChange}
        disabled={pending || !plugin.installed}
        aria-label={`${sourceLabel} policy for ${plugin.name}`}
        aria-busy={pending}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-xs text-muted-foreground">
          {pending ? 'Saving…' : effectiveEnabled ? 'On' : 'Off'}
        </span>
        {policy ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto justify-start p-0 text-xs"
            onClick={onReset}
            disabled={pending}
          >
            Reset
          </Button>
        ) : null}
        {failed ? (
          <span className="text-xs text-destructive" role="alert">
            Failed to save
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function PluginsPage() {
  const queryClient = useQueryClient();
  const { showSuccess, showError } = useToastHelpers();
  const { selectedProjectId, selectedProject } = useSelectedProject();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const policiesKey = providerPluginPoliciesKey(selectedProjectId);

  const pluginsQuery = useQuery({
    queryKey: providerPluginsKey,
    queryFn: ({ signal }) => fetchProviderPlugins({ signal }),
    enabled: Boolean(selectedProjectId),
  });
  const policiesQuery = useQuery({
    queryKey: policiesKey,
    queryFn: ({ signal }) => fetchProviderPluginPolicies(selectedProjectId as string, { signal }),
    enabled: Boolean(selectedProjectId),
  });

  const policyByKey = useMemo(() => {
    const result = new Map<string, ProviderPluginPolicy>();
    for (const policy of policiesQuery.data ?? []) {
      result.set(policyKey(policy.providerId, policy.pluginId, policy.source), policy);
    }
    return result;
  }, [policiesQuery.data]);

  const filteredPlugins = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return (pluginsQuery.data ?? [])
      .filter((plugin) => {
        const matchesSearch =
          normalizedSearch.length === 0 || getSearchValue(plugin).includes(normalizedSearch);
        const matchesProvider = plugin.providerName.toLowerCase() === 'claude';
        const matchesStatus =
          statusFilter === 'all' ||
          (statusFilter === 'installed' && plugin.installed) ||
          (statusFilter === 'available' && plugin.available && !plugin.installed);
        return matchesSearch && matchesProvider && matchesStatus;
      })
      .sort((left, right) => {
        const leftDefault = policyByKey.get(policyKey(left.providerId, left.pluginId, 'default'));
        const leftProject = policyByKey.get(policyKey(left.providerId, left.pluginId, 'project'));
        const rightDefault = policyByKey.get(
          policyKey(right.providerId, right.pluginId, 'default'),
        );
        const rightProject = policyByKey.get(
          policyKey(right.providerId, right.pluginId, 'project'),
        );
        const leftActive = left.installed && getProjectEnabled(left, leftProject, leftDefault);
        const rightActive = right.installed && getProjectEnabled(right, rightProject, rightDefault);

        return (
          Number(rightActive) - Number(leftActive) ||
          left.providerName.localeCompare(right.providerName) ||
          (left.marketplaceName ?? '').localeCompare(right.marketplaceName ?? '') ||
          left.name.localeCompare(right.name) ||
          left.pluginId.localeCompare(right.pluginId)
        );
      });
  }, [pluginsQuery.data, policyByKey, search, statusFilter]);

  const policyMutation = useCrudMutation<
    ProviderPluginPolicy | void,
    PolicyMutationVariables,
    void
  >({
    mutationFn: async ({ scope, plugin, enabled, reset }: PolicyMutationVariables) => {
      if (!selectedProjectId) {
        throw new Error('Select a project before changing plugin policy.');
      }

      if (scope === 'default') {
        return reset
          ? resetProviderPluginDefault(plugin.providerId, plugin.pluginId)
          : setProviderPluginDefault(plugin.providerId, plugin.pluginId, enabled === true);
      }

      return reset
        ? resetProjectProviderPluginPolicy(selectedProjectId, plugin.providerId, plugin.pluginId)
        : setProjectProviderPluginPolicy(
            selectedProjectId,
            plugin.providerId,
            plugin.pluginId,
            enabled === true,
          );
    },
    invalidateKeys: [policiesKey],
    toast: {
      success: (_, variables) => ({
        title: variables.reset ? 'Plugin policy reset' : 'Plugin policy saved',
        description: variables.reset
          ? `${variables.plugin.name} now uses the next effective policy layer.`
          : `${variables.plugin.name} ${variables.enabled ? 'enabled' : 'disabled'} for ${variables.scope === 'default' ? 'DevChain Default' : 'This Project'}.`,
      }),
      error: (error, variables) => ({
        title: 'Failed to save plugin policy',
        description: getErrorMessage(error, `Could not update ${variables.plugin.name}.`),
      }),
    },
  });

  const refreshMutation = useMutation({
    mutationFn: refreshProviderPlugins,
    onSuccess: async (plugins) => {
      await queryClient.cancelQueries({ queryKey: providerPluginsKey });
      queryClient.setQueryData(providerPluginsKey, plugins);
      showSuccess({
        title: 'Plugin catalog refreshed',
        description: `${plugins.length} plugin${plugins.length === 1 ? '' : 's'} found.`,
      });
    },
    onError: (error) => {
      showError({
        title: 'Failed to refresh plugin catalog',
        description: getErrorMessage(error, 'Try again after checking the provider CLIs.'),
      });
    },
  });

  if (!selectedProjectId) {
    return (
      <div className="container space-y-6 py-6">
        <div>
          <h1 className="text-2xl font-bold text-pretty">Provider Plugins</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Discover provider-native plugins and control their DevChain policy.
          </p>
        </div>
        <div
          className="flex min-h-[220px] items-center justify-center rounded-md border border-dashed"
          aria-live="polite"
        >
          <p className="text-sm text-muted-foreground">
            Select a project to manage provider plugins.
          </p>
        </div>
      </div>
    );
  }

  if (pluginsQuery.error || policiesQuery.error) {
    const error = pluginsQuery.error ?? policiesQuery.error;
    const retryFailedQueries = () => {
      const retries: Array<Promise<unknown>> = [];
      if (pluginsQuery.error) {
        retries.push(pluginsQuery.refetch());
      }
      if (policiesQuery.error) {
        retries.push(policiesQuery.refetch());
      }
      void Promise.all(retries);
    };

    return (
      <div className="container space-y-6 py-6">
        <div>
          <h1 className="text-2xl font-bold text-pretty">Provider Plugins</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Project: {selectedProject?.name ?? selectedProjectId}
          </p>
        </div>
        <div
          className="flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-md border border-dashed"
          role="alert"
        >
          <AlertCircle className="h-5 w-5 text-destructive" aria-hidden="true" />
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : 'Failed to load provider plugins.'}
          </p>
          <Button type="button" variant="outline" onClick={retryFailedQueries}>
            Try Again
          </Button>
        </div>
      </div>
    );
  }

  const isLoading = pluginsQuery.isLoading || policiesQuery.isLoading;

  return (
    <div className="container space-y-6 py-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-pretty">Provider Plugins</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Project: {selectedProject?.name ?? selectedProjectId}. Native installation is separate
            from DevChain policy.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => refreshMutation.mutate()}
          disabled={refreshMutation.isPending}
          aria-busy={refreshMutation.isPending}
        >
          {refreshMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
          )}
          {refreshMutation.isPending ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <div className="flex flex-col gap-3 rounded-md border bg-card p-4 sm:flex-row sm:items-end">
        <div className="relative w-full sm:max-w-sm">
          <label htmlFor="plugin-search" className="mb-1.5 block text-sm font-medium">
            Search
          </label>
          <Search
            className="absolute left-2.5 top-9 h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="plugin-search"
            name="pluginSearch"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search plugins…"
            className="pl-8"
            autoComplete="off"
            aria-label="Search plugins"
          />
        </div>
        <div className="w-full sm:w-44">
          <span className="mb-1.5 block text-sm font-medium">Provider</span>
          <div
            className="flex h-10 items-center rounded-md border border-input bg-muted px-3 text-sm text-muted-foreground"
            aria-label="Provider filter pinned to Claude"
          >
            Claude
          </div>
        </div>
        <div className="w-full sm:w-44">
          <label htmlFor="plugin-status-filter" className="mb-1.5 block text-sm font-medium">
            Status
          </label>
          <Select
            value={statusFilter}
            onValueChange={(value) => setStatusFilter(value as StatusFilter)}
          >
            <SelectTrigger id="plugin-status-filter" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="installed">Installed</SelectItem>
              <SelectItem value="available">Available</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="pb-2 text-sm text-muted-foreground" aria-live="polite">
          {isLoading
            ? 'Loading…'
            : `${filteredPlugins.length} plugin${filteredPlugins.length === 1 ? '' : 's'}`}
        </p>
      </div>

      <div className="rounded-md border">
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow>
              <TableHead>Plugin</TableHead>
              <TableHead className="w-[120px]">Provider</TableHead>
              <TableHead className="w-[150px]">Installed</TableHead>
              <TableHead className="w-[220px]">DevChain Default</TableHead>
              <TableHead className="w-[220px]">This Project</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Loading…
                  </span>
                </TableCell>
              </TableRow>
            ) : filteredPlugins.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  {search.trim() || statusFilter !== 'all'
                    ? 'No plugins match these filters.'
                    : 'No provider plugins are available.'}
                </TableCell>
              </TableRow>
            ) : (
              filteredPlugins.map((plugin) => {
                const defaultPolicy = policyByKey.get(
                  policyKey(plugin.providerId, plugin.pluginId, 'default'),
                );
                const projectPolicy = policyByKey.get(
                  policyKey(plugin.providerId, plugin.pluginId, 'project'),
                );
                const defaultEnabled = getDefaultEnabled(plugin, defaultPolicy);
                const projectEnabled = getProjectEnabled(plugin, projectPolicy, defaultPolicy);
                const defaultPending =
                  policyMutation.isPending &&
                  policyMutation.variables?.scope === 'default' &&
                  policyMutation.variables.plugin.providerId === plugin.providerId &&
                  policyMutation.variables.plugin.pluginId === plugin.pluginId;
                const projectPending =
                  policyMutation.isPending &&
                  policyMutation.variables?.scope === 'project' &&
                  policyMutation.variables.plugin.providerId === plugin.providerId &&
                  policyMutation.variables.plugin.pluginId === plugin.pluginId;
                const defaultFailed =
                  policyMutation.isError &&
                  policyMutation.variables?.scope === 'default' &&
                  policyMutation.variables.plugin.providerId === plugin.providerId &&
                  policyMutation.variables.plugin.pluginId === plugin.pluginId;
                const projectFailed =
                  policyMutation.isError &&
                  policyMutation.variables?.scope === 'project' &&
                  policyMutation.variables.plugin.providerId === plugin.providerId &&
                  policyMutation.variables.plugin.pluginId === plugin.pluginId;

                return (
                  <TableRow key={`${plugin.providerId}:${plugin.pluginId}`}>
                    <TableCell className="min-w-0">
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="truncate font-medium" title={plugin.name} translate="no">
                          {plugin.name}
                        </span>
                        <span
                          className="truncate text-xs text-muted-foreground"
                          title={plugin.pluginId}
                          translate="no"
                        >
                          {plugin.pluginId}
                        </span>
                        {plugin.description ? (
                          <span
                            className="line-clamp-1 text-xs text-muted-foreground"
                            title={plugin.description}
                          >
                            {plugin.description}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="font-medium" translate="no">
                        {plugin.providerName}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        <Badge
                          variant="outline"
                          className={cn(
                            plugin.installed
                              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                              : plugin.available
                                ? 'border-blue-200 bg-blue-50 text-blue-800'
                                : 'border-slate-200 bg-slate-50 text-slate-700',
                          )}
                        >
                          {plugin.installed
                            ? 'Installed'
                            : plugin.available
                              ? 'Available'
                              : 'Unavailable'}
                        </Badge>
                        {plugin.installed && !plugin.providerEnabled ? (
                          <span className="text-xs text-amber-700">Provider capability is off</span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <PolicyControl
                        plugin={plugin}
                        source="default"
                        policy={defaultPolicy}
                        effectiveEnabled={defaultEnabled}
                        pending={defaultPending}
                        failed={defaultFailed}
                        onChange={(enabled) =>
                          policyMutation.mutate({ scope: 'default', plugin, enabled })
                        }
                        onReset={() =>
                          policyMutation.mutate({ scope: 'default', plugin, reset: true })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <PolicyControl
                        plugin={plugin}
                        source="project"
                        policy={projectPolicy}
                        effectiveEnabled={projectEnabled}
                        pending={projectPending}
                        failed={projectFailed}
                        onChange={(enabled) =>
                          policyMutation.mutate({ scope: 'project', plugin, enabled })
                        }
                        onReset={() =>
                          policyMutation.mutate({ scope: 'project', plugin, reset: true })
                        }
                      />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
