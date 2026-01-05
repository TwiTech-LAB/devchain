import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Badge } from '@/ui/components/ui/badge';
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
import { Plus, Server, AlertCircle } from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import { fetchPreflightChecks } from '@/ui/lib/preflight';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';

type ProviderType = 'codex' | 'claude' | 'gemini';

function getDefaultBinPathForType(t: ProviderType) {
  if (t === 'codex') return 'codex';
  if (t === 'claude') return 'claude';
  if (t === 'gemini') return 'gemini';
  return '';
}

interface Provider {
  id: string;
  name: string;
  binPath: string | null;
  mcpConfigured: boolean;
  mcpEndpoint: string | null;
  mcpRegisteredAt: string | null;
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

async function createProvider(data: { name: string; binPath: string | null }) {
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

async function updateProvider(id: string, data: { binPath?: string | null }) {
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

export function ProvidersPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedProject } = useSelectedProject();
  const [showDialog, setShowDialog] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Provider | null>(null);
  const [formData, setFormData] = useState({ binPath: '' });
  const [formError, setFormError] = useState<string | null>(null);
  const [formErrorField, setFormErrorField] = useState<'binPath' | null>(null);
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
      setFormData({ binPath: '' });
      setFormError(null);
      setFormErrorField(null);
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
        setFormErrorField('binPath');
      }
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create provider',
        variant: 'destructive',
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { binPath?: string | null } }) =>
      updateProvider(id, data),
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
      setFormData({ binPath: '' });
      setFormError(null);
      setFormErrorField(null);
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
        setFormErrorField('binPath');
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const binPath = formData.binPath.trim() === '' ? null : formData.binPath.trim();
    const providerName = editingProvider?.name ?? providerType;
    setFormError(null);
    setFormErrorField(null);

    if (editingProvider) {
      updateMutation.mutate({
        id: editingProvider.id,
        data: { binPath },
      });
    } else {
      createMutation.mutate({ name: providerName, binPath });
    }
  };

  const handleEdit = (provider: Provider) => {
    setEditingProvider(provider);
    setFormData({ binPath: provider.binPath || '' });
    // derive provider type from existing provider
    const t: ProviderType = (
      provider.name === 'codex'
        ? 'codex'
        : provider.name === 'claude'
          ? 'claude'
          : provider.name === 'gemini'
            ? 'gemini'
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
    setFormData({ binPath: getDefaultBinPathForType(initialType) });
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
            setFormData({ binPath: '' });
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
                onValueChange={(value) => {
                  const prevDefault = getDefaultBinPathForType(providerType);
                  const nextType = value as ProviderType;
                  const nextDefault = getDefaultBinPathForType(nextType);
                  setProviderType(nextType);
                  setFormData((prev) => {
                    // Update binPath if user hasn't touched it or it equals previous default
                    if (!binPathTouched || prev.binPath.trim() === prevDefault) {
                      return { ...prev, binPath: nextDefault };
                    }
                    return prev;
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
                  setFormData({ ...formData, binPath: e.target.value });
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

            {/* MCP endpoint is auto-configured: ${window.location.origin}/mcp */}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowDialog(false);
                  setEditingProvider(null);
                  const initialType = 'codex';
                  setFormData({ binPath: getDefaultBinPathForType(initialType) });
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
