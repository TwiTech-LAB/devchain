import { useRef, useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Textarea } from '@/ui/components/ui/textarea';
import { Label } from '@/ui/components/ui/label';
import { Badge } from '@/ui/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/ui/components/ui/dialog';
import { getErrorMessage, useToastHelpers } from '@/ui/lib/toast-helpers';
import {
  Plus,
  Server,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Trash2,
  Loader2,
  Search,
} from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import { EnvEditor, type EnvEditorHandle } from '@/ui/components/EnvEditor';
import { ProviderEnvScopePopover } from '@/ui/components/ProviderEnvScopePopover';
import { fetchPreflightChecks } from '@/ui/lib/preflight';
import { providerModelQueryKeys } from '@/ui/lib/provider-model-query-keys';
import { providerEffortQueryKeys } from '@/ui/lib/provider-effort-query-keys';
import { providersQueryKeys } from '@/ui/lib/providers-query-keys';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import {
  useCrudMutation,
  optimisticAdd,
  optimisticMergeById,
  optimisticRemoveById,
} from '@/ui/hooks/useCrudMutations';
import { getMcpEndpointUrl } from '@/ui/lib/mcp-endpoint';
import {
  DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON,
  validateClaudeLaunchSettingsJson,
} from '@devchain/shared';

type ProviderType = 'codex' | 'claude' | 'opencode' | 'agy' | 'copilot';

function getDefaultBinPathForType(t: ProviderType) {
  if (t === 'codex') return 'codex';
  if (t === 'claude') return 'claude';
  if (t === 'opencode') return 'opencode';
  if (t === 'agy') return 'agy';
  if (t === 'copilot') return 'copilot';
  return '';
}

interface Provider {
  id: string;
  name: string;
  binPath: string | null;
  autoCompactThreshold: number | null;
  env: Record<string, string> | null;
  envScopes: Record<string, string[]>;
  mcpConfigured: boolean;
  mcpEndpoint: string | null;
  mcpRegisteredAt: string | null;
  claudeLaunchSettingsJson: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProviderModel {
  id: string;
  providerId: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

interface ProviderEffort {
  id: string;
  providerId: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

// Response shape of GET /api/providers/:id/efforts (Task 3). supportsEffort is the
// capability signal derived from isEffortCapable(adapter) at that endpoint only;
// empty efforts ≠ unsupported. requiresModelForEffort is true for per-model effort
// mechanisms (e.g. opencode); surfaced so the UI can require a model selection.
interface ProviderEffortsResponse {
  efforts: ProviderEffort[];
  supportsEffort: boolean;
  requiresModelForEffort: boolean;
}

interface ProviderMutationError extends Error {
  field?: string;
}

function isProviderMutationError(error: unknown): error is ProviderMutationError {
  return Boolean(error && typeof error === 'object' && 'field' in error);
}

interface ProvidersQueryData {
  items: Provider[];
  total?: number;
  limit?: number;
  offset?: number;
}

async function fetchProviders() {
  const res = await fetch('/api/providers');
  if (!res.ok) throw new Error('Failed to fetch providers');
  return res.json();
}

async function createProvider(data: {
  name: string;
  binPath: string | null;
  autoCompactThreshold?: number;
  claudeLaunchSettingsJson?: string | null;
  env?: Record<string, string> | null;
}) {
  const res = await fetch('/api/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to create provider' }));
    const mutationError = new Error(
      error.message || 'Failed to create provider',
    ) as ProviderMutationError;
    if (error.field) {
      mutationError.field = error.field;
    }
    throw mutationError;
  }
  return res.json();
}

async function updateProvider(
  id: string,
  data: {
    binPath?: string | null;
    autoCompactThreshold?: number | null;
    claudeLaunchSettingsJson?: string | null;
    env?: Record<string, string> | null;
    envScopes?: Record<string, string[]>;
  },
) {
  const res = await fetch(`/api/providers/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to update provider' }));
    const mutationError = new Error(
      error.message || 'Failed to update provider',
    ) as ProviderMutationError;
    if (error.field) {
      mutationError.field = error.field;
    }
    throw mutationError;
  }
  return res.json();
}

async function deleteProvider(id: string) {
  const res = await fetch(`/api/providers/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to delete provider' }));
    // Use the detailed message from the backend if available
    const message = error.message || error.details || 'Failed to delete provider';
    throw new Error(message);
  }
}

async function ensureProviderMcp(id: string, projectPath?: string) {
  const body = projectPath ? JSON.stringify({ projectPath }) : JSON.stringify({});
  const res = await fetch(`/api/providers/${id}/mcp/ensure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to ensure MCP configuration' }));
    throw new Error(error.message || 'Failed to ensure MCP configuration');
  }
  return res.json();
}

async function fetchProviderModels(providerId: string): Promise<ProviderModel[]> {
  const res = await fetch(`/api/providers/${providerId}/models`);
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to fetch provider models' }));
    throw new Error(error.message || 'Failed to fetch provider models');
  }
  return res.json();
}

async function addProviderModel(providerId: string, name: string): Promise<ProviderModel> {
  const res = await fetch(`/api/providers/${providerId}/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to add model' }));
    throw new Error(error.message || 'Failed to add model');
  }
  return res.json();
}

async function removeProviderModel(providerId: string, modelId: string): Promise<void> {
  const res = await fetch(`/api/providers/${providerId}/models/${modelId}`, { method: 'DELETE' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to delete model' }));
    throw new Error(error.message || 'Failed to delete model');
  }
}

async function discoverProviderModels(
  providerId: string,
): Promise<{ added: string[]; existing: string[]; total: number }> {
  const res = await fetch(`/api/providers/${providerId}/models/discover`, { method: 'POST' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to auto-discover models' }));
    throw new Error(error.message || 'Failed to auto-discover models');
  }
  return res.json();
}

async function fetchProviderEfforts(providerId: string): Promise<ProviderEffortsResponse> {
  const res = await fetch(`/api/providers/${providerId}/efforts`);
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to fetch provider efforts' }));
    throw new Error(error.message || 'Failed to fetch provider efforts');
  }
  return res.json();
}

async function addProviderEffort(providerId: string, name: string): Promise<ProviderEffort> {
  const res = await fetch(`/api/providers/${providerId}/efforts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to add effort' }));
    throw new Error(error.message || 'Failed to add effort');
  }
  return res.json();
}

async function removeProviderEffort(providerId: string, effortId: string): Promise<void> {
  const res = await fetch(`/api/providers/${providerId}/efforts/${effortId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to delete effort' }));
    throw new Error(error.message || 'Failed to delete effort');
  }
}

interface SyncResult {
  providerId: string;
  insertedCount: number;
  affectedProjectIds: string[];
  skippedExistingCount: number;
  skippedConflictCount: number;
  warnings: Array<{ projectId: string; profileId?: string; configName?: string; reason: string }>;
}

interface RescanResult {
  discovered: Array<{ name: string; binPath: string }>;
  alreadyPresent: string[];
  notFound: string[];
  syncResults: SyncResult[];
}

async function rescanProviders(): Promise<RescanResult> {
  const res = await fetch('/api/providers/rescan', { method: 'POST' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Rescan failed' }));
    throw new Error(error.message || 'Failed to rescan providers');
  }
  return res.json();
}

function invalidateProviderConfigQueries(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({
    predicate: (q) => {
      const k = q.queryKey[0];
      return (
        k === 'providers' ||
        k === 'provider-configs' ||
        k === 'profile-provider-configs' ||
        k === 'provider-configs-by-profile' ||
        k === 'worktree-profile-provider-configs'
      );
    },
  });
  // Also refresh the providers-page preflight badge
  queryClient.invalidateQueries({ queryKey: providersQueryKeys.preflightAll() });
}

function ProviderModelsSection({ provider }: { provider: Provider }) {
  const queryClient = useQueryClient();
  const { toast, showSuccess, showError } = useToastHelpers();
  const [isOpen, setIsOpen] = useState(false);
  const [newModelName, setNewModelName] = useState('');
  const [modelDeleteConfirm, setModelDeleteConfirm] = useState<ProviderModel | null>(null);
  const modelsQueryKey = providerModelQueryKeys.main(provider.id);

  const {
    data: models = [],
    isLoading,
    isFetching,
    isError,
    error,
  } = useQuery({
    queryKey: modelsQueryKey,
    queryFn: () => fetchProviderModels(provider.id),
    enabled: true,
  });

  const addModelMutation = useMutation({
    mutationFn: (name: string) => addProviderModel(provider.id, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: providerModelQueryKeys.all });
      setNewModelName('');
      showSuccess({
        title: 'Model added',
        description: `Added model to ${provider.name}.`,
      });
    },
    onError: (mutationError) => {
      showError({
        title: 'Add failed',
        description: getErrorMessage(mutationError, 'Failed to add model.'),
      });
    },
  });

  const deleteModelMutation = useMutation({
    mutationFn: (modelId: string) => removeProviderModel(provider.id, modelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: providerModelQueryKeys.all });
      setModelDeleteConfirm(null);
      showSuccess({
        title: 'Model deleted',
        description: `Removed model from ${provider.name}.`,
      });
    },
    onError: (mutationError) => {
      setModelDeleteConfirm(null);
      showError({
        title: 'Delete failed',
        description: getErrorMessage(mutationError, 'Failed to delete model.'),
      });
    },
  });

  const discoverModelsMutation = useMutation({
    mutationFn: () => discoverProviderModels(provider.id),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: providerModelQueryKeys.all });
      showSuccess({
        title: 'Discovery complete',
        description: `Added ${result.added.length} models, ${result.existing.length} already existed.`,
      });
    },
    onError: (mutationError) => {
      showError({
        title: 'Auto-discover failed',
        description: getErrorMessage(mutationError, 'Failed to discover models for provider.'),
      });
    },
  });

  const handleAddModel = () => {
    const name = newModelName.trim();
    if (!name) {
      toast({
        title: 'Model name required',
        description: 'Enter a model name before adding.',
        variant: 'destructive',
      });
      return;
    }
    addModelMutation.mutate(name);
  };

  const modelCount = models.length;

  return (
    <>
      <Collapsible open={isOpen} onOpenChange={setIsOpen} className="mt-4 border-t pt-4">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="w-full justify-between px-2">
            <span className="flex items-center gap-2 text-sm font-medium">
              {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              Models ({modelCount})
              {isFetching && <span className="text-xs text-muted-foreground">Refreshing...</span>}
            </span>
            <span className="text-xs text-muted-foreground">Manage provider models</span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-3 pt-3">
          {isLoading && <p className="text-sm text-muted-foreground">Loading models...</p>}
          {isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(error, 'Failed to load models.')}
            </p>
          )}

          {!isLoading && !isError && (
            <>
              <div className="max-h-56 overflow-y-auto rounded-md border bg-background">
                {models.length === 0 && (
                  <p className="px-3 py-2 text-sm text-muted-foreground">No models configured.</p>
                )}
                {models.map((model) => (
                  <div
                    key={model.id}
                    className="flex items-center justify-between gap-2 border-b px-3 py-2 last:border-b-0"
                  >
                    <code className="text-xs">{model.name}</code>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setModelDeleteConfirm(model)}
                      aria-label={`Delete model ${model.name}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <Input
                  value={newModelName}
                  onChange={(e) => setNewModelName(e.target.value)}
                  placeholder="provider/model-name"
                  aria-label="Add Model"
                />
                <Button onClick={handleAddModel} disabled={addModelMutation.isPending}>
                  Add Model
                </Button>
              </div>

              <div className="flex flex-wrap gap-2">
                {provider.name.toLowerCase() === 'opencode' && (
                  <Button
                    variant="outline"
                    onClick={() => discoverModelsMutation.mutate()}
                    disabled={discoverModelsMutation.isPending}
                  >
                    {discoverModelsMutation.isPending ? 'Discovering...' : 'Auto Discover'}
                  </Button>
                )}
              </div>
            </>
          )}
        </CollapsibleContent>
      </Collapsible>

      <Dialog
        open={!!modelDeleteConfirm}
        onOpenChange={(open) => !open && setModelDeleteConfirm(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Model</DialogTitle>
            <DialogDescription>
              Delete <strong>{modelDeleteConfirm?.name}</strong> from {provider.name}?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setModelDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                modelDeleteConfirm && deleteModelMutation.mutate(modelDeleteConfirm.id)
              }
              disabled={deleteModelMutation.isPending}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ProviderEffortsSection({ provider }: { provider: Provider }) {
  const queryClient = useQueryClient();
  const { toast, showSuccess, showError } = useToastHelpers();
  const [isOpen, setIsOpen] = useState(false);
  const [newEffortName, setNewEffortName] = useState('');
  const [effortDeleteConfirm, setEffortDeleteConfirm] = useState<ProviderEffort | null>(null);
  const effortsQueryKey = providerEffortQueryKeys.main(provider.id);

  const { data, isLoading, isFetching, isError, error } = useQuery({
    queryKey: effortsQueryKey,
    queryFn: () => fetchProviderEfforts(provider.id),
    enabled: true,
  });

  const efforts = data?.efforts ?? [];
  const supportsEffort = data?.supportsEffort ?? false;
  const requiresModelForEffort = data?.requiresModelForEffort ?? false;

  const addEffortMutation = useMutation({
    mutationFn: (name: string) => addProviderEffort(provider.id, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: providerEffortQueryKeys.all });
      setNewEffortName('');
      showSuccess({
        title: 'Effort level added',
        description: `Added effort level to ${provider.name}.`,
      });
    },
    onError: (mutationError) => {
      showError({
        title: 'Add failed',
        description: getErrorMessage(mutationError, 'Failed to add effort level.'),
      });
    },
  });

  const deleteEffortMutation = useMutation({
    mutationFn: (effortId: string) => removeProviderEffort(provider.id, effortId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: providerEffortQueryKeys.all });
      setEffortDeleteConfirm(null);
      showSuccess({
        title: 'Effort level deleted',
        description: `Removed effort level from ${provider.name}.`,
      });
    },
    onError: (mutationError) => {
      setEffortDeleteConfirm(null);
      showError({
        title: 'Delete failed',
        description: getErrorMessage(mutationError, 'Failed to delete effort level.'),
      });
    },
  });

  const handleAddEffort = () => {
    const name = newEffortName.trim();
    if (!name) {
      toast({
        title: 'Effort level required',
        description: 'Enter an effort level before adding.',
        variant: 'destructive',
      });
      return;
    }
    addEffortMutation.mutate(name);
  };

  // Hidden entirely when the provider is not effort-capable (e.g. agy) or until the
  // capability signal resolves. Empty ≠ unsupported: a capable provider with an empty
  // catalog still shows the section + add affordance below (mirrors Models empty state).
  if (!supportsEffort) {
    return null;
  }

  const effortCount = efforts.length;

  return (
    <>
      <Collapsible open={isOpen} onOpenChange={setIsOpen} className="mt-4 border-t pt-4">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="w-full justify-between px-2">
            <span className="flex items-center gap-2 text-sm font-medium">
              {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              Effort Levels ({effortCount})
              {isFetching && <span className="text-xs text-muted-foreground">Refreshing...</span>}
            </span>
            <span className="text-xs text-muted-foreground">Manage provider effort levels</span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-3 pt-3">
          {isLoading && <p className="text-sm text-muted-foreground">Loading effort levels...</p>}
          {isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(error, 'Failed to load effort levels.')}
            </p>
          )}

          {!isLoading && !isError && (
            <>
              <div className="max-h-56 overflow-y-auto rounded-md border bg-background">
                {efforts.length === 0 && (
                  <p className="px-3 py-2 text-sm text-muted-foreground">
                    No effort levels configured.
                  </p>
                )}
                {efforts.map((effort) => (
                  <div
                    key={effort.id}
                    className="flex items-center justify-between gap-2 border-b px-3 py-2 last:border-b-0"
                  >
                    <code className="text-xs">{effort.name}</code>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEffortDeleteConfirm(effort)}
                      aria-label={`Delete effort level ${effort.name}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <Input
                  value={newEffortName}
                  onChange={(e) => setNewEffortName(e.target.value)}
                  placeholder="high"
                  aria-label="Add Effort Level"
                />
                <Button onClick={handleAddEffort} disabled={addEffortMutation.isPending}>
                  Add Effort Level
                </Button>
              </div>

              {requiresModelForEffort && (
                <p className="text-xs text-muted-foreground">
                  Effort values for this provider apply per-model.
                </p>
              )}
            </>
          )}
        </CollapsibleContent>
      </Collapsible>

      <Dialog
        open={!!effortDeleteConfirm}
        onOpenChange={(open) => !open && setEffortDeleteConfirm(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Effort Level</DialogTitle>
            <DialogDescription>
              Delete <strong>{effortDeleteConfirm?.name}</strong> from {provider.name}?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEffortDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                effortDeleteConfirm && deleteEffortMutation.mutate(effortDeleteConfirm.id)
              }
              disabled={deleteEffortMutation.isPending}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ProvidersPage() {
  const queryClient = useQueryClient();
  const { toast, showSuccess, showError } = useToastHelpers();
  const { selectedProject } = useSelectedProject();
  const [showDialog, setShowDialog] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Provider | null>(null);
  const [formData, setFormData] = useState({
    binPath: '',
    autoCompactThreshold: '',
    claudeLaunchSettingsJson: '',
    env: {} as Record<string, string>,
    envScopes: {} as Record<string, string[]>,
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [formErrorField, setFormErrorField] = useState<
    'binPath' | 'autoCompactThreshold' | 'claudeLaunchSettingsJson' | null
  >(null);
  const [providerType, setProviderType] = useState<ProviderType>('codex');
  const [binPathTouched, setBinPathTouched] = useState(false);
  const envEditorRef = useRef<EnvEditorHandle>(null);

  const { data: providersData, isLoading } = useQuery({
    queryKey: providersQueryKeys.list(),
    queryFn: fetchProviders,
  });

  const { data: allProjectsData } = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: () => fetch('/api/projects?limit=10000').then((r) => r.json()),
    staleTime: 60000,
  });
  const allProjectsForScope: Array<{ id: string; name: string }> = useMemo(
    () =>
      (allProjectsData?.items ?? []).map((p: { id: string; name: string }) => ({
        id: p.id,
        name: p.name,
      })),
    [allProjectsData],
  );

  const {
    data: preflightResult,
    isLoading: isPreflightLoading,
    isError: isPreflightError,
  } = useQuery({
    queryKey: providersQueryKeys.preflight(selectedProject?.rootPath),
    queryFn: () => fetchPreflightChecks(selectedProject?.rootPath, { includeAllProviders: true }),
    staleTime: 60000,
    refetchInterval: false,
  });

  const supportedProviders = useMemo(
    () => preflightResult?.supportedMcpProviders ?? [],
    [preflightResult?.supportedMcpProviders],
  );

  type ProvidersList = ProvidersQueryData;
  const providersListKey = providersQueryKeys.list();

  const createMutation = useCrudMutation<
    { provider: Provider; sync: SyncResult | null; syncError?: string },
    Parameters<typeof createProvider>[0],
    void
  >({
    mutationFn: createProvider,
    optimistic: {
      queryKey: providersListKey,
      // temp-id prepend. total is server-owned and corrected on invalidate, so
      // the optimistic row does not bump it (matches the prior inline behavior).
      project: (previous, newProvider) => {
        const list = (previous as ProvidersList | undefined) ?? { items: [] as Provider[] };
        const optimisticRow = {
          id: 'temp-' + Date.now(),
          ...newProvider,
          env: newProvider.env ?? null,
          mcpConfigured: false,
          mcpEndpoint: null,
          mcpRegisteredAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as Provider;
        return optimisticAdd(list, optimisticRow, { trackTotal: false });
      },
    },
    toast: {
      error: (error) => ({
        title: 'Error',
        description: getErrorMessage(error, 'Failed to create provider'),
      }),
    },
    // No invalidateKeys: the create fan-out is a predicate over multiple domains
    // (invalidateProviderConfigQueries), which the kit's key-list can't express.
    onSuccessSideEffects: (data) => {
      invalidateProviderConfigQueries(queryClient);
      setShowDialog(false);
      setFormData({
        binPath: '',
        autoCompactThreshold: '',
        claudeLaunchSettingsJson: '',
        env: {},
        envScopes: {},
      });
      setFormError(null);
      setFormErrorField(null);
      if (data.sync) {
        const desc =
          data.sync.insertedCount > 0
            ? `Propagated ${data.sync.insertedCount} config(s) across ${data.sync.affectedProjectIds.length} project(s)${data.sync.warnings.length > 0 ? ` with ${data.sync.warnings.length} warning(s)` : ''}`
            : 'No new configs needed';
        showSuccess({ title: `Provider ${data.provider.name} created`, description: desc });
      } else if (data.syncError) {
        showError({
          title: `Provider ${data.provider.name} created`,
          description: `Propagation failed: ${data.syncError}`,
        });
      } else {
        showSuccess({ title: 'Success', description: 'Provider created successfully' });
      }
    },
    onErrorSideEffects: (error) => {
      if (isProviderMutationError(error) && error.field) {
        setFormError(error.message);
        setFormErrorField(
          error.field === 'autoCompactThreshold'
            ? 'autoCompactThreshold'
            : error.field === 'claudeLaunchSettingsJson'
              ? 'claudeLaunchSettingsJson'
              : 'binPath',
        );
      }
    },
  });

  const updateMutation = useCrudMutation<
    Provider,
    {
      id: string;
      data: {
        binPath?: string | null;
        autoCompactThreshold?: number | null;
        claudeLaunchSettingsJson?: string | null;
        env?: Record<string, string> | null;
        envScopes?: Record<string, string[]>;
      };
    },
    void
  >({
    mutationFn: ({ id, data }) => updateProvider(id, data),
    optimistic: {
      queryKey: providersListKey,
      // in-place merge — per-field spread + server-authored updatedAt.
      project: (previous, { id, data }) => {
        const list = (previous as ProvidersList | undefined) ?? { items: [] as Provider[] };
        return optimisticMergeById(list, id, (p) => ({
          ...p,
          ...data,
          updatedAt: new Date().toISOString(),
        }));
      },
    },
    invalidateKeys: [providersListKey, providersQueryKeys.preflightAll()],
    toast: {
      error: (error) => ({
        title: 'Error',
        description: getErrorMessage(error, 'Failed to update provider'),
      }),
    },
    onSuccessSideEffects: () => {
      setShowDialog(false);
      setEditingProvider(null);
      setFormData({
        binPath: '',
        autoCompactThreshold: '',
        claudeLaunchSettingsJson: '',
        env: {},
        envScopes: {},
      });
      setFormError(null);
      setFormErrorField(null);
      showSuccess({
        title: 'Success',
        description: 'Provider updated successfully',
      });
    },
    onErrorSideEffects: (error) => {
      if (isProviderMutationError(error) && error.field) {
        setFormError(error.message);
        setFormErrorField(
          error.field === 'autoCompactThreshold'
            ? 'autoCompactThreshold'
            : error.field === 'claudeLaunchSettingsJson'
              ? 'claudeLaunchSettingsJson'
              : 'binPath',
        );
      }
    },
  });

  const deleteMutation = useCrudMutation<void, string, void>({
    mutationFn: deleteProvider,
    optimistic: {
      queryKey: providersListKey,
      // filter-out the matched id.
      project: (previous, id) => {
        const list = (previous as ProvidersList | undefined) ?? { items: [] as Provider[] };
        return optimisticRemoveById(list, id, { trackTotal: false });
      },
    },
    invalidateKeys: [providersListKey, providersQueryKeys.preflightAll()],
    toast: {
      error: (error) => ({
        title: 'Error',
        description: getErrorMessage(error, 'Failed to delete provider'),
      }),
    },
    onSuccessSideEffects: () => {
      setDeleteConfirm(null);
      showSuccess({
        title: 'Success',
        description: 'Provider deleted successfully',
      });
    },
    onErrorSideEffects: () => {
      setDeleteConfirm(null);
    },
  });

  const configureMutation = useMutation({
    mutationFn: (id: string) => ensureProviderMcp(id, selectedProject?.rootPath),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: providersListKey });
      // Refresh preflight so MCP badge updates immediately
      queryClient.invalidateQueries({ queryKey: ['preflight'] });
      queryClient.refetchQueries({ queryKey: ['preflight'] });

      const actionText =
        {
          added: 'MCP configured successfully',
          fixed_mismatch: 'MCP configuration fixed',
          already_configured: 'MCP already configured',
        }[result?.action as 'added' | 'fixed_mismatch' | 'already_configured'] ||
        'MCP configuration updated';

      showSuccess({
        title: actionText,
        description: `Endpoint: ${getMcpEndpointUrl()}`,
      });
    },
    onError: (error) => {
      showError({
        title: 'MCP configuration failed',
        description: getErrorMessage(error, 'Failed to configure MCP.'),
      });
    },
  });

  const rescanMutation = useMutation({
    mutationFn: rescanProviders,
    onSuccess: (result) => {
      invalidateProviderConfigQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: ['preflight'] });
      const totalPropagated = result.syncResults.reduce((sum, s) => sum + s.insertedCount, 0);
      let desc = `${result.discovered.length} new, ${result.alreadyPresent.length} already registered, ${result.notFound.length} not found`;
      if (result.discovered.length > 0) {
        const names = result.discovered.map((d) => d.name).join(', ');
        desc +=
          `\nDiscovered: ${names}` +
          (totalPropagated > 0 ? ` (${totalPropagated} configs propagated)` : '');
      }
      showSuccess({ title: 'Rescan complete', description: desc });
    },
    onError: (error) => {
      showError({
        title: 'Rescan failed',
        description: getErrorMessage(error, 'Failed to rescan providers.'),
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const binPath = formData.binPath.trim() === '' ? null : formData.binPath.trim();
    const providerName = editingProvider?.name ?? providerType;
    setFormError(null);
    setFormErrorField(null);

    const thresholdStr = formData.autoCompactThreshold.trim();
    // Validate autoCompactThreshold when non-empty
    if (thresholdStr !== '') {
      const parsed = Number(thresholdStr);
      if (isNaN(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        setFormError('Threshold must be an integer between 1 and 100.');
        setFormErrorField('autoCompactThreshold');
        return;
      }
    }

    const isClaude = providerName.toLowerCase() === 'claude';
    const claudeLaunchSettingsJson =
      formData.claudeLaunchSettingsJson.trim() === '' ? null : formData.claudeLaunchSettingsJson;
    if (isClaude) {
      const validation = validateClaudeLaunchSettingsJson(claudeLaunchSettingsJson);
      if (!validation.valid) {
        setFormError(validation.message);
        setFormErrorField('claudeLaunchSettingsJson');
        return;
      }
    }

    const committedEnv = envEditorRef.current?.commitPending();
    if (committedEnv === null) return;
    const env = committedEnv ?? formData.env;

    if (editingProvider) {
      const autoCompactThreshold: number | null = thresholdStr === '' ? null : Number(thresholdStr);
      updateMutation.mutate({
        id: editingProvider.id,
        data: {
          binPath,
          autoCompactThreshold,
          ...(isClaude ? { claudeLaunchSettingsJson } : {}),
          env: Object.keys(env).length > 0 ? env : null,
          envScopes: formData.envScopes,
        },
      });
    } else {
      const payload: {
        name: string;
        binPath: string | null;
        autoCompactThreshold?: number;
        claudeLaunchSettingsJson?: string | null;
        env?: Record<string, string> | null;
      } = {
        name: providerName,
        binPath,
        env: Object.keys(env).length > 0 ? env : null,
      };
      if (thresholdStr !== '' && providerType === 'claude') {
        payload.autoCompactThreshold = Number(thresholdStr);
      }
      if (providerType === 'claude') {
        payload.claudeLaunchSettingsJson = claudeLaunchSettingsJson;
      }
      createMutation.mutate(payload);
    }
  };

  const handleEdit = (provider: Provider) => {
    setEditingProvider(provider);
    setFormData({
      binPath: provider.binPath || '',
      autoCompactThreshold:
        provider.autoCompactThreshold != null ? String(provider.autoCompactThreshold) : '',
      claudeLaunchSettingsJson: provider.claudeLaunchSettingsJson ?? '',
      env: provider.env ?? {},
      envScopes: provider.envScopes ?? {},
    });
    // derive provider type from existing provider
    const t: ProviderType = (
      provider.name === 'codex'
        ? 'codex'
        : provider.name === 'claude'
          ? 'claude'
          : provider.name === 'opencode'
            ? 'opencode'
            : provider.name === 'agy'
              ? 'agy'
              : provider.name === 'copilot'
                ? 'copilot'
                : 'codex'
    ) as ProviderType;
    setProviderType(t);
    setBinPathTouched(false);
    setFormError(null);
    setFormErrorField(null);
    setShowDialog(true);
  };

  const handleDelete = (provider: Provider) => {
    setDeleteConfirm(provider);
  };

  const confirmDelete = () => {
    if (deleteConfirm) {
      deleteMutation.mutate(deleteConfirm.id);
    }
  };

  const handleConfigure = (provider: Provider) => {
    if (!supportedProviders.includes(provider.name)) {
      toast({
        title: 'Unsupported provider',
        description: `${provider.name} does not support MCP registration.`,
      });
      return;
    }

    configureMutation.mutate(provider.id);
  };

  const handleOpenDialog = () => {
    setEditingProvider(null);
    const initialType = 'codex';
    setFormData({
      binPath: getDefaultBinPathForType(initialType),
      autoCompactThreshold: '',
      claudeLaunchSettingsJson: '',
      env: {},
      envScopes: {},
    });
    setProviderType(initialType);
    setBinPathTouched(false);
    setFormError(null);
    setFormErrorField(null);
    setShowDialog(true);
  };

  return (
    <div>
      <div className="mb-6 flex justify-between items-start">
        <div>
          <h1 className="text-3xl font-bold mb-2">Providers</h1>
          <p className="text-muted-foreground">
            Manage AI provider configurations for agent profiles
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => rescanMutation.mutate()}
            disabled={rescanMutation.isPending}
          >
            {rescanMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Search className="h-4 w-4 mr-2" />
            )}
            Rescan
          </Button>
          <Button onClick={handleOpenDialog}>
            <Plus className="h-4 w-4 mr-2" />
            Add Provider
          </Button>
        </div>
      </div>

      {isLoading && <p className="text-muted-foreground">Loading providers...</p>}

      {providersData && (
        <div className="space-y-4">
          {providersData.items.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center border rounded-lg">
              <Server className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-lg font-medium mb-2">No Providers Yet</p>
              <p className="text-muted-foreground mb-4">
                Add your first AI provider (Claude, Codex, etc.) to get started
              </p>
              <Button onClick={handleOpenDialog}>
                <Plus className="h-4 w-4 mr-2" />
                Add Provider
              </Button>
            </div>
          )}

          {providersData.items.map((provider: Provider) => {
            const isSupported = supportedProviders.includes(provider.name);
            const pf = preflightResult?.providers?.find((p) => p.id === provider.id);
            const mcpStatus = pf?.mcpStatus;

            let mcpBadge: React.ReactNode;
            if (isPreflightLoading && !preflightResult) {
              mcpBadge = (
                <Badge
                  variant="secondary"
                  className="text-xs border border-muted-foreground/30 text-muted-foreground"
                >
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  Checking…
                </Badge>
              );
            } else if (isPreflightError) {
              mcpBadge = (
                <Badge
                  variant="secondary"
                  className="text-xs border border-destructive bg-destructive/10 text-destructive"
                >
                  MCP Check failed
                </Badge>
              );
            } else if (mcpStatus === 'pass') {
              mcpBadge = (
                <Badge
                  variant="secondary"
                  className="text-xs border border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
                >
                  MCP OK
                </Badge>
              );
            } else if (mcpStatus === 'fail') {
              mcpBadge = (
                <Badge
                  variant="secondary"
                  className="text-xs border border-destructive bg-destructive/10 text-destructive"
                >
                  MCP FAIL
                </Badge>
              );
            } else if (
              mcpStatus === 'warn' &&
              pf?.requiresProjectContext === true &&
              !selectedProject
            ) {
              mcpBadge = (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="secondary"
                        className="text-xs border border-amber-500/40 bg-amber-500/10 text-amber-600"
                      >
                        MCP WARN
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>Select a project to verify</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              );
            } else if (mcpStatus === 'warn') {
              const warnBadge = (
                <Badge
                  variant="secondary"
                  className="text-xs border border-amber-500/40 bg-amber-500/10 text-amber-600"
                >
                  MCP WARN
                </Badge>
              );
              mcpBadge = pf?.mcpMessage ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>{warnBadge}</TooltipTrigger>
                    <TooltipContent>{pf.mcpMessage}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : (
                warnBadge
              );
            } else if (pf?.status === 'fail') {
              // Defensive: allSettled rejection set status:'fail' but mcpStatus was not populated.
              // Render FAIL badge so this anomaly is never silently dropped to neutral "—".
              mcpBadge = (
                <Badge
                  variant="secondary"
                  className="text-xs border border-destructive bg-destructive/10 text-destructive"
                >
                  MCP FAIL
                </Badge>
              );
            } else {
              mcpBadge = (
                <Badge variant="outline" className="text-xs text-muted-foreground">
                  MCP —
                </Badge>
              );
            }

            return (
              <div key={provider.id} className="border rounded-lg p-4 bg-card">
                <div className="flex justify-between items-start gap-4">
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <Server className="h-5 w-5 text-muted-foreground" />
                      <h3 className="text-lg font-semibold">{provider.name}</h3>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <span className="text-sm">Binary Path:</span>
                      <code className="text-sm bg-muted px-2 py-0.5 rounded">
                        {provider.binPath || 'Not configured'}
                      </code>
                    </div>
                    {provider.name.toLowerCase() === 'claude' && (
                      <div className="text-sm text-muted-foreground">
                        Default threshold:{' '}
                        {provider.autoCompactThreshold != null
                          ? `${provider.autoCompactThreshold}%`
                          : 'disabled'}
                      </div>
                    )}
                    {provider.env && Object.keys(provider.env).length > 0 && (
                      <div className="text-sm">
                        <span className="text-muted-foreground">Env:</span>{' '}
                        <span className="font-mono">{Object.keys(provider.env).join(', ')}</span>
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      {mcpBadge}
                      {provider.mcpRegisteredAt && (
                        <span className="text-xs text-muted-foreground">
                          Registered {new Date(provider.mcpRegisteredAt).toLocaleString()}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Created {new Date(provider.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    {isSupported &&
                      pf &&
                      (pf.mcpStatus === 'warn' || pf.mcpStatus === 'fail') &&
                      (pf.requiresProjectContext === true && !selectedProject ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled
                                  style={{ pointerEvents: 'none' }}
                                >
                                  Configure MCP
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>Select a project first</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleConfigure(provider)}
                          disabled={configureMutation.isPending}
                        >
                          Configure MCP
                        </Button>
                      ))}
                    <Button variant="outline" size="sm" onClick={() => handleEdit(provider)}>
                      Edit
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => handleDelete(provider)}>
                      Delete
                    </Button>
                  </div>
                </div>
                <ProviderModelsSection provider={provider} />
                <ProviderEffortsSection provider={provider} />
              </div>
            );
          })}
        </div>
      )}

      {/* Create/Edit Provider Dialog */}
      <Dialog
        open={showDialog}
        onOpenChange={(open) => {
          setShowDialog(open);
          if (!open) {
            setEditingProvider(null);
            setFormData({
              binPath: '',
              autoCompactThreshold: '',
              claudeLaunchSettingsJson: '',
              env: {},
              envScopes: {},
            });
            setFormError(null);
            setFormErrorField(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingProvider ? 'Edit Provider' : 'Add Provider'}</DialogTitle>
            <DialogDescription>
              {editingProvider
                ? 'Update the provider configuration'
                : 'Configure a new AI provider for use in agent profiles'}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="provider-type">Provider Type</Label>
              <Select
                value={providerType}
                disabled={!!editingProvider}
                onValueChange={(value) => {
                  const prevDefault = getDefaultBinPathForType(providerType);
                  const nextType = value as ProviderType;
                  const nextDefault = getDefaultBinPathForType(nextType);
                  setProviderType(nextType);
                  setFormData((prev) => {
                    const updates: Partial<typeof prev> = {};
                    // Update binPath if user hasn't touched it or it equals previous default
                    if (!binPathTouched || prev.binPath.trim() === prevDefault) {
                      updates.binPath = nextDefault;
                    }
                    // Clear Claude-specific fields when switching away from Claude
                    if (nextType !== 'claude') {
                      updates.autoCompactThreshold = '';
                      updates.claudeLaunchSettingsJson = '';
                    } else if (providerType !== 'claude') {
                      updates.claudeLaunchSettingsJson = DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON;
                    }
                    return Object.keys(updates).length > 0 ? { ...prev, ...updates } : prev;
                  });
                }}
              >
                <SelectTrigger id="provider-type">
                  <SelectValue placeholder="Select provider type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="codex">Codex</SelectItem>
                  <SelectItem value="claude">Claude</SelectItem>
                  <SelectItem value="opencode">OpenCode</SelectItem>
                  <SelectItem value="agy">Antigravity CLI</SelectItem>
                  <SelectItem value="copilot">Copilot CLI</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                Select the provider type (controls default binary name).
              </p>
            </div>
            {/* Name field removed — provider name derived from preset type */}

            <div>
              <Label htmlFor="provider-binpath">Binary Path</Label>
              <Input
                id="provider-binpath"
                type="text"
                value={formData.binPath}
                onChange={(e) => {
                  setFormData((prev) => ({
                    ...prev,
                    binPath: e.target.value,
                  }));
                  setBinPathTouched(true);
                  setFormError(null);
                  setFormErrorField(null);
                }}
                className={cn(
                  formErrorField === 'binPath' &&
                    'border-destructive focus-visible:ring-destructive',
                )}
                placeholder="/path/to/provider/binary"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Absolute path to provider binary (optional, can be configured later)
              </p>
              {formError && formErrorField === 'binPath' && (
                <p className="mt-2 text-sm text-destructive">{formError}</p>
              )}
            </div>

            {(editingProvider?.name ?? providerType).toLowerCase() === 'claude' && (
              <>
                <div>
                  <Label htmlFor="provider-threshold">Default Threshold (%)</Label>
                  <Input
                    id="provider-threshold"
                    type="number"
                    min={1}
                    max={100}
                    value={formData.autoCompactThreshold}
                    onChange={(e) => {
                      setFormData({ ...formData, autoCompactThreshold: e.target.value });
                      if (formErrorField === 'autoCompactThreshold') {
                        setFormError(null);
                        setFormErrorField(null);
                      }
                    }}
                    className={cn(
                      formErrorField === 'autoCompactThreshold' &&
                        'border-destructive focus-visible:ring-destructive',
                    )}
                    placeholder="Default: 85"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Context usage percentage (1-100) that triggers auto-compact. Leave empty to use
                    default on create, or to disable on edit.
                  </p>
                  {formError && formErrorField === 'autoCompactThreshold' && (
                    <p className="mt-2 text-sm text-destructive">{formError}</p>
                  )}
                </div>

                <div className="space-y-2 rounded-md border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="provider-claude-launch-settings">
                      Advanced: Claude Launch Settings JSON
                    </Label>
                    {editingProvider && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setFormData((previous) => ({
                            ...previous,
                            claudeLaunchSettingsJson: DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON,
                          }));
                          setFormError(null);
                          setFormErrorField(null);
                        }}
                      >
                        Restore DevChain default
                      </Button>
                    )}
                  </div>
                  <Textarea
                    id="provider-claude-launch-settings"
                    rows={9}
                    spellCheck={false}
                    value={formData.claudeLaunchSettingsJson}
                    onChange={(event) => {
                      setFormData((previous) => ({
                        ...previous,
                        claudeLaunchSettingsJson: event.target.value,
                      }));
                      if (formErrorField === 'claudeLaunchSettingsJson') {
                        setFormError(null);
                        setFormErrorField(null);
                      }
                    }}
                    className={cn(
                      'font-mono text-xs',
                      formErrorField === 'claudeLaunchSettingsJson' &&
                        'border-destructive focus-visible:ring-destructive',
                    )}
                  />
                  {formError && formErrorField === 'claudeLaunchSettingsJson' && (
                    <p className="text-sm text-destructive">{formError}</p>
                  )}
                </div>
              </>
            )}

            <div>
              <Label>Environment Variables</Label>
              <p className="text-xs text-muted-foreground mt-1 mb-2">
                This env is shared across all projects using this provider.
              </p>
              <EnvEditor
                ref={envEditorRef}
                env={formData.env}
                onChange={(env) =>
                  setFormData((prev) => {
                    const prevKeys = new Set(Object.keys(prev.env));
                    const nextKeys = new Set(Object.keys(env));
                    const removed = [...prevKeys].filter((k) => !nextKeys.has(k));
                    if (removed.length === 0) return { ...prev, env };
                    const envScopes = { ...prev.envScopes };
                    removed.forEach((k) => delete envScopes[k]);
                    return { ...prev, env, envScopes };
                  })
                }
                renderRowExtra={(key, _value) => (
                  <ProviderEnvScopePopover
                    envKey={key}
                    selectedProjectIds={formData.envScopes[key] ?? []}
                    allProjects={allProjectsForScope}
                    onChange={(ids) =>
                      setFormData((prev) => {
                        const envScopes = { ...prev.envScopes };
                        if (ids.length === 0) {
                          delete envScopes[key];
                        } else {
                          envScopes[key] = ids;
                        }
                        return { ...prev, envScopes };
                      })
                    }
                  />
                )}
              />
            </div>

            {/* MCP endpoint is auto-configured: ${window.location.origin}/mcp */}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowDialog(false);
                  setEditingProvider(null);
                  const initialType = 'codex';
                  setFormData({
                    binPath: getDefaultBinPathForType(initialType),
                    autoCompactThreshold: '',
                    claudeLaunchSettingsJson: '',
                    env: {},
                    envScopes: {},
                  });
                  setProviderType(initialType);
                  setBinPathTouched(false);
                  setFormError(null);
                  setFormErrorField(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                {editingProvider ? 'Update' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Provider</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{deleteConfirm?.name}</strong>? Any agent
              profiles using this provider will be affected.
            </DialogDescription>
          </DialogHeader>
          <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-3 flex items-start gap-2">
            <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-500 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-amber-800 dark:text-amber-200">
              This action cannot be undone. Make sure no profiles are currently using this provider.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleteMutation.isPending}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
