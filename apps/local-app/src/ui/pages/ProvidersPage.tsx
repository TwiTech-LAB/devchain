import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Badge } from '@/ui/components/ui/badge';
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
import { useToast } from '@/ui/hooks/use-toast';
import { Checkbox } from '@/ui/components/ui/checkbox';
import {
  Plus,
  Server,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Trash2,
  Loader2,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import { fetchPreflightChecks } from '@/ui/lib/preflight';
import { providerModelQueryKeys } from '@/ui/lib/provider-model-query-keys';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';

type ProviderType = 'codex' | 'claude' | 'gemini' | 'opencode';

function getDefaultBinPathForType(t: ProviderType) {
  if (t === 'codex') return 'codex';
  if (t === 'claude') return 'claude';
  if (t === 'gemini') return 'gemini';
  if (t === 'opencode') return 'opencode';
  return '';
}

interface Provider {
  id: string;
  name: string;
  binPath: string | null;
  autoCompactThreshold: number | null;
  autoCompactThreshold1m: number | null;
  oneMillionContextEnabled: boolean;
  mcpConfigured: boolean;
  mcpEndpoint: string | null;
  mcpRegisteredAt: string | null;
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
  oneMillionContextEnabled?: boolean;
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
    autoCompactThreshold1m?: number | null;
    oneMillionContextEnabled?: boolean;
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

async function probeProvider1mContext(
  id: string,
): Promise<{ supported: boolean; status: string; capture?: string; detail?: string }> {
  const res = await fetch(`/api/providers/${id}/1m-context/probe`, { method: 'POST' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Probe failed' }));
    throw new Error(error.message || 'Failed to probe 1M context support');
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

function ProviderModelsSection({ provider }: { provider: Provider }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
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
      toast({
        title: 'Model added',
        description: `Added model to ${provider.name}.`,
      });
    },
    onError: (mutationError) => {
      toast({
        title: 'Add failed',
        description:
          mutationError instanceof Error ? mutationError.message : 'Failed to add model.',
        variant: 'destructive',
      });
    },
  });

  const deleteModelMutation = useMutation({
    mutationFn: (modelId: string) => removeProviderModel(provider.id, modelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: providerModelQueryKeys.all });
      setModelDeleteConfirm(null);
      toast({
        title: 'Model deleted',
        description: `Removed model from ${provider.name}.`,
      });
    },
    onError: (mutationError) => {
      setModelDeleteConfirm(null);
      toast({
        title: 'Delete failed',
        description:
          mutationError instanceof Error ? mutationError.message : 'Failed to delete model.',
        variant: 'destructive',
      });
    },
  });

  const discoverModelsMutation = useMutation({
    mutationFn: () => discoverProviderModels(provider.id),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: providerModelQueryKeys.all });
      toast({
        title: 'Discovery complete',
        description: `Added ${result.added.length} models, ${result.existing.length} already existed.`,
      });
    },
    onError: (mutationError) => {
      toast({
        title: 'Auto-discover failed',
        description:
          mutationError instanceof Error
            ? mutationError.message
            : 'Failed to discover models for provider.',
        variant: 'destructive',
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
              {error instanceof Error ? error.message : 'Failed to load models.'}
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

export function ProvidersPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedProject } = useSelectedProject();
  const [showDialog, setShowDialog] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Provider | null>(null);
  const [formData, setFormData] = useState({
    binPath: '',
    autoCompactThreshold: '',
    autoCompactThreshold1m: '',
    oneMillionContextEnabled: false,
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [formErrorField, setFormErrorField] = useState<'binPath' | 'autoCompactThreshold' | null>(
    null,
  );
  const [probeStatus, setProbeStatus] = useState<
    'idle' | 'probing' | 'supported' | 'unsupported' | 'error'
  >('idle');
  const [providerType, setProviderType] = useState<ProviderType>('codex');
  const [binPathTouched, setBinPathTouched] = useState(false);

  const { data: providersData, isLoading } = useQuery({
    queryKey: ['providers'],
    queryFn: fetchProviders,
  });

  const { data: preflightResult } = useQuery({
    queryKey: ['preflight', 'providers-page', selectedProject?.rootPath ?? 'global'],
    queryFn: () => fetchPreflightChecks(selectedProject?.rootPath),
    staleTime: 30000,
    refetchInterval: 60000,
  });

  const supportedProviders = useMemo(
    () => preflightResult?.supportedMcpProviders ?? [],
    [preflightResult?.supportedMcpProviders],
  );

  const createMutation = useMutation({
    mutationFn: createProvider,
    onMutate: async (newProvider) => {
      await queryClient.cancelQueries({ queryKey: ['providers'] });
      const previousData = queryClient.getQueryData(['providers']);

      queryClient.setQueryData(['providers'], (old: ProvidersQueryData | undefined) => ({
        ...old,
        items: [
          {
            id: 'temp-' + Date.now(),
            ...newProvider,
            mcpConfigured: false,
            mcpEndpoint: null,
            mcpRegisteredAt: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          ...(old?.items || []),
        ],
      }));

      return { previousData };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['providers'] });
      setShowDialog(false);
      setFormData({
        binPath: '',
        autoCompactThreshold: '',
        autoCompactThreshold1m: '',
        oneMillionContextEnabled: false,
      });
      setFormError(null);
      setFormErrorField(null);
      setProbeStatus('idle');
      toast({
        title: 'Success',
        description: 'Provider created successfully',
      });
    },
    onError: (error, variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['providers'], context.previousData);
      }
      if (isProviderMutationError(error) && error.field) {
        setFormError(error.message);
        setFormErrorField(
          error.field === 'autoCompactThreshold' ? 'autoCompactThreshold' : 'binPath',
        );
      }
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create provider',
        variant: 'destructive',
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: {
        binPath?: string | null;
        autoCompactThreshold?: number | null;
        autoCompactThreshold1m?: number | null;
        oneMillionContextEnabled?: boolean;
      };
    }) => updateProvider(id, data),
    onMutate: async ({ id, data }) => {
      await queryClient.cancelQueries({ queryKey: ['providers'] });
      const previousData = queryClient.getQueryData(['providers']);

      queryClient.setQueryData(['providers'], (old: ProvidersQueryData | undefined) => ({
        ...old,
        items: old?.items.map((p: Provider) =>
          p.id === id ? { ...p, ...data, updatedAt: new Date().toISOString() } : p,
        ),
      }));

      return { previousData };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['providers'] });
      setShowDialog(false);
      setEditingProvider(null);
      setFormData({
        binPath: '',
        autoCompactThreshold: '',
        autoCompactThreshold1m: '',
        oneMillionContextEnabled: false,
      });
      setFormError(null);
      setFormErrorField(null);
      setProbeStatus('idle');
      toast({
        title: 'Success',
        description: 'Provider updated successfully',
      });
    },
    onError: (error, variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['providers'], context.previousData);
      }
      if (isProviderMutationError(error) && error.field) {
        setFormError(error.message);
        setFormErrorField(
          error.field === 'autoCompactThreshold' ? 'autoCompactThreshold' : 'binPath',
        );
      }
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update provider',
        variant: 'destructive',
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteProvider,
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['providers'] });
      const previousData = queryClient.getQueryData(['providers']);

      queryClient.setQueryData(['providers'], (old: ProvidersQueryData | undefined) => ({
        ...old,
        items: old?.items.filter((p: Provider) => p.id !== id),
      }));

      return { previousData };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['providers'] });
      setDeleteConfirm(null);
      toast({
        title: 'Success',
        description: 'Provider deleted successfully',
      });
    },
    onError: (error, variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['providers'], context.previousData);
      }
      setDeleteConfirm(null);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete provider',
        variant: 'destructive',
      });
    },
  });

  const configureMutation = useMutation({
    mutationFn: (id: string) => ensureProviderMcp(id, selectedProject?.rootPath),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['providers'] });
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

      toast({
        title: actionText,
        description: `Endpoint: ${window.location.origin}/mcp`,
      });
    },
    onError: (error) => {
      toast({
        title: 'MCP configuration failed',
        description: error instanceof Error ? error.message : 'Failed to configure MCP.',
        variant: 'destructive',
      });
    },
  });

  const handleProbe1mContext = async (providerId: string) => {
    setProbeStatus('probing');
    try {
      const result = await probeProvider1mContext(providerId);
      if (result.supported) {
        setProbeStatus('supported');
        setFormData((prev) => ({
          ...prev,
          oneMillionContextEnabled: true,
          autoCompactThreshold1m: '50',
          autoCompactThreshold: '95',
        }));
        toast({ title: '1M context supported', description: 'Threshold set to 50%.' });
      } else {
        if (result.status === 'unsupported') {
          setProbeStatus('unsupported');
          toast({
            title: '1M context not supported',
            description: result.detail ?? 'Binary does not support 1M.',
            variant: 'destructive',
          });
        } else {
          // launch_failure / timeout — retryable
          setProbeStatus('error');
          toast({
            title: 'Probe failed',
            description: result.detail ?? `Status: ${result.status}`,
            variant: 'destructive',
          });
        }
        setFormData((prev) => ({ ...prev, oneMillionContextEnabled: false }));
      }
    } catch (error) {
      setProbeStatus('error');
      setFormData((prev) => ({ ...prev, oneMillionContextEnabled: false }));
      toast({
        title: 'Probe failed',
        description: error instanceof Error ? error.message : 'Failed to probe 1M context.',
        variant: 'destructive',
      });
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const binPath = formData.binPath.trim() === '' ? null : formData.binPath.trim();
    const providerName = editingProvider?.name ?? providerType;
    setFormError(null);
    setFormErrorField(null);

    const thresholdStr = formData.autoCompactThreshold.trim();
    const threshold1mStr = formData.autoCompactThreshold1m.trim();

    // Validate autoCompactThreshold when non-empty
    if (thresholdStr !== '') {
      const parsed = Number(thresholdStr);
      if (isNaN(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        setFormError('Threshold must be an integer between 1 and 100.');
        setFormErrorField('autoCompactThreshold');
        return;
      }
    }

    const isClaude = (editingProvider?.name ?? providerType).toLowerCase() === 'claude';

    // Validate autoCompactThreshold1m when 1M is enabled and value is non-empty
    if (isClaude && formData.oneMillionContextEnabled && threshold1mStr !== '') {
      const parsed1m = Number(threshold1mStr);
      if (isNaN(parsed1m) || !Number.isInteger(parsed1m) || parsed1m < 1 || parsed1m > 100) {
        setFormError('1M threshold must be an integer between 1 and 100.');
        setFormErrorField('autoCompactThreshold');
        return;
      }
    }

    if (editingProvider) {
      const autoCompactThreshold: number | null = thresholdStr === '' ? null : Number(thresholdStr);
      const autoCompactThreshold1m: number | null =
        isClaude && formData.oneMillionContextEnabled && threshold1mStr !== ''
          ? Number(threshold1mStr)
          : null;
      updateMutation.mutate({
        id: editingProvider.id,
        data: {
          binPath,
          autoCompactThreshold,
          ...(isClaude
            ? {
                oneMillionContextEnabled: formData.oneMillionContextEnabled,
                autoCompactThreshold1m,
              }
            : {}),
        },
      });
    } else {
      const payload: {
        name: string;
        binPath: string | null;
        autoCompactThreshold?: number;
      } = {
        name: providerName,
        binPath,
      };
      if (thresholdStr !== '' && providerType === 'claude') {
        payload.autoCompactThreshold = Number(thresholdStr);
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
      autoCompactThreshold1m: provider.autoCompactThreshold1m?.toString() ?? '',
      oneMillionContextEnabled: provider.oneMillionContextEnabled ?? false,
    });
    setProbeStatus(provider.oneMillionContextEnabled ? 'supported' : 'idle');
    // derive provider type from existing provider
    const t: ProviderType = (
      provider.name === 'codex'
        ? 'codex'
        : provider.name === 'claude'
          ? 'claude'
          : provider.name === 'gemini'
            ? 'gemini'
            : provider.name === 'opencode'
              ? 'opencode'
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
      autoCompactThreshold1m: '',
      oneMillionContextEnabled: false,
    });
    setProviderType(initialType);
    setBinPathTouched(false);
    setFormError(null);
    setFormErrorField(null);
    setProbeStatus('idle');
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
        <Button onClick={handleOpenDialog}>
          <Plus className="h-4 w-4 mr-2" />
          Add Provider
        </Button>
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
            const mcpBadgeClass =
              mcpStatus === 'pass'
                ? 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-600'
                : mcpStatus === 'fail'
                  ? 'border border-destructive bg-destructive/10 text-destructive'
                  : 'border border-amber-500/40 bg-amber-500/10 text-amber-600';

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
                      <>
                        <div className="text-sm text-muted-foreground">
                          1M context: {provider.oneMillionContextEnabled ? 'enabled' : 'disabled'}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          Auto-compact:{' '}
                          {provider.autoCompactThreshold != null
                            ? `${provider.autoCompactThreshold}%`
                            : 'disabled'}
                        </div>
                      </>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" className={cn('text-xs', mcpBadgeClass)}>
                        MCP {(mcpStatus ?? 'warn').toUpperCase()}
                      </Badge>
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
                    {isSupported && mcpStatus !== 'pass' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleConfigure(provider)}
                        disabled={configureMutation.isPending}
                      >
                        Configure MCP
                      </Button>
                    )}
                    <Button variant="outline" size="sm" onClick={() => handleEdit(provider)}>
                      Edit
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => handleDelete(provider)}>
                      Delete
                    </Button>
                  </div>
                </div>
                <ProviderModelsSection provider={provider} />
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
              autoCompactThreshold1m: '',
              oneMillionContextEnabled: false,
            });
            setFormError(null);
            setFormErrorField(null);
            setProbeStatus('idle');
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
                      updates.autoCompactThreshold1m = '';
                      updates.oneMillionContextEnabled = false;
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
                  <SelectItem value="gemini">Gemini</SelectItem>
                  <SelectItem value="opencode">OpenCode</SelectItem>
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
                  const newBinPath = e.target.value;
                  const isClaude = (editingProvider?.name ?? providerType) === 'claude';
                  setFormData((prev) => ({
                    ...prev,
                    binPath: newBinPath,
                    // Invalidate 1M state when Claude binPath changes
                    ...(isClaude && prev.oneMillionContextEnabled
                      ? {
                          oneMillionContextEnabled: false,
                          autoCompactThreshold1m: '',
                          autoCompactThreshold: '95',
                        }
                      : {}),
                  }));
                  if (isClaude && probeStatus === 'supported') {
                    setProbeStatus('idle');
                  }
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
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="provider-1m-context"
                    checked={formData.oneMillionContextEnabled}
                    disabled={
                      probeStatus === 'probing' ||
                      !editingProvider ||
                      (editingProvider &&
                        formData.binPath.trim() !== (editingProvider.binPath ?? ''))
                    }
                    onCheckedChange={(checked) => {
                      if (checked) {
                        // Run probe for existing providers only
                        const providerId = editingProvider?.id;
                        if (providerId) {
                          handleProbe1mContext(providerId);
                        }
                      } else {
                        setFormData((prev) => ({
                          ...prev,
                          oneMillionContextEnabled: false,
                          autoCompactThreshold1m: '',
                          autoCompactThreshold: '95',
                        }));
                        setProbeStatus('idle');
                      }
                    }}
                  />
                  <Label htmlFor="provider-1m-context" className="cursor-pointer">
                    1M context
                  </Label>
                  {probeStatus === 'probing' && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Checking support...
                    </span>
                  )}
                  {probeStatus === 'supported' && (
                    <span className="flex items-center gap-1 text-xs text-emerald-600">
                      <CheckCircle2 className="h-3 w-3" />
                      Supported
                    </span>
                  )}
                  {probeStatus === 'unsupported' && (
                    <span className="flex items-center gap-1 text-xs text-destructive">
                      <XCircle className="h-3 w-3" />
                      Not supported
                    </span>
                  )}
                  {probeStatus === 'error' && (
                    <span className="flex items-center gap-1 text-xs text-destructive">
                      <XCircle className="h-3 w-3" />
                      Probe failed
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground ml-6">
                  Enable 1M token context window for Claude sessions. Requires Claude binary
                  support.
                </p>
                {editingProvider && formData.binPath.trim() !== (editingProvider.binPath ?? '') && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 ml-6">
                    Save the new binary path first, then re-probe for 1M context support.
                  </p>
                )}
                {formData.oneMillionContextEnabled &&
                  formData.autoCompactThreshold1m !== '' &&
                  Number(formData.autoCompactThreshold1m) > 50 && (
                    <div className="ml-6 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 dark:border-amber-800 dark:bg-amber-950">
                      <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-500 mt-0.5 flex-shrink-0" />
                      <p className="text-xs text-amber-800 dark:text-amber-200">
                        1M threshold above 50% may degrade output quality. Consider lowering it to
                        50%.
                      </p>
                    </div>
                  )}
              </div>
            )}

            {(editingProvider?.name ?? providerType).toLowerCase() === 'claude' && (
              <div className="space-y-3">
                {formData.oneMillionContextEnabled ? (
                  <>
                    <div>
                      <Label htmlFor="provider-threshold-1m">Opus 1M Threshold (%)</Label>
                      <Input
                        id="provider-threshold-1m"
                        type="number"
                        min={1}
                        max={100}
                        value={formData.autoCompactThreshold1m}
                        onChange={(e) => {
                          setFormData({ ...formData, autoCompactThreshold1m: e.target.value });
                          if (formErrorField === 'autoCompactThreshold') {
                            setFormError(null);
                            setFormErrorField(null);
                          }
                        }}
                        className={cn(
                          formErrorField === 'autoCompactThreshold' &&
                            'border-destructive focus-visible:ring-destructive',
                        )}
                        placeholder="Default: 50"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        Context usage percentage (1-100) for Opus with 1M context window.
                      </p>
                    </div>
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
                        placeholder="Default: 95"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        Context usage percentage (1-100) for standard models (sonnet/haiku).
                      </p>
                    </div>
                  </>
                ) : (
                  <div>
                    <Label htmlFor="provider-threshold">Auto-Compact Threshold (%)</Label>
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
                      Context usage percentage (1-100) that triggers auto-compact. Leave empty to
                      use default on create, or to disable on edit.
                    </p>
                  </div>
                )}
                {formError && formErrorField === 'autoCompactThreshold' && (
                  <p className="mt-2 text-sm text-destructive">{formError}</p>
                )}
              </div>
            )}

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
                    autoCompactThreshold1m: '',
                    oneMillionContextEnabled: false,
                  });
                  setProviderType(initialType);
                  setBinPathTouched(false);
                  setFormError(null);
                  setFormErrorField(null);
                  setProbeStatus('idle');
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
