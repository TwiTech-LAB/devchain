import { useRef, useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Badge } from '@/ui/components/ui/badge';
import { Textarea } from '@/ui/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/ui/components/ui/dialog';
import { getErrorMessage, useToastHelpers } from '@/ui/lib/toast-helpers';
import { useConfirmDialog, useFormDialog } from '@/ui/hooks/useFormDialog';
import {
  optimisticAdd,
  optimisticMergeById,
  optimisticRemoveById,
  useCrudMutation,
  type ListContainer,
} from '@/ui/hooks/useCrudMutations';
import {
  Plus,
  GripVertical,
  X,
  ArrowUp,
  ArrowDown,
  Users,
  Settings2,
  Trash2,
  ChevronDown,
  ChevronUp,
  AlertCircle,
} from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import { providersQueryKeys } from '@/ui/lib/providers-query-keys';
import { EnvEditor, type EnvEditorHandle } from '@/ui/components/EnvEditor';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { MarkdownReferenceInput } from '@/ui/components/shared';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';

interface Prompt {
  id: string;
  title: string;
  content: string;
}

interface ProfilePrompt {
  promptId: string;
  order: number;
  prompt: Prompt;
}

interface Provider {
  id: string;
  name: string;
  binPath: string | null;
}

interface AgentProfile {
  id: string;
  name: string;
  familySlug?: string | null;
  provider?: Provider; // Enriched from provider configs
  instructions?: string | null;
  prompts?: ProfilePrompt[];
  agentCount?: number;
  createdAt: string;
  updatedAt: string;
}

interface ProviderConfig {
  id: string;
  profileId: string;
  providerId: string;
  name: string;
  description: string | null;
  options: string | null;
  env: Record<string, string> | null;
  model: string | null;
  effort: string | null;
  createdAt: string;
  updatedAt: string;
}

async function fetchProfiles(projectId: string) {
  const res = await fetch(`/api/profiles?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) throw new Error('Failed to fetch profiles');
  return res.json();
}

async function fetchPrompts(projectId: string) {
  const res = await fetch(`/api/prompts?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) throw new Error('Failed to fetch prompts');
  return res.json();
}

async function fetchProviders() {
  const res = await fetch('/api/providers');
  if (!res.ok) throw new Error('Failed to fetch providers');
  return res.json();
}

// Note: providerId and options removed in Phase 4
// Provider configuration now managed via ProviderConfigsSection
async function createProfile(data: {
  projectId: string;
  name: string;
  familySlug?: string | null;
  promptIds?: string[];
  instructions?: string | null;
}) {
  const res = await fetch('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to create profile');
  return res.json();
}

async function updateProfile(
  id: string,
  data: {
    name?: string;
    familySlug?: string | null;
    promptIds?: string[];
    instructions?: string | null;
  },
) {
  const res = await fetch(`/api/profiles/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to update profile');
  return res.json();
}

async function replaceProfilePrompts(id: string, promptIds: string[]) {
  const res = await fetch(`/api/profiles/${id}/prompts`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ promptIds }),
  });
  if (!res.ok) throw new Error('Failed to update profile prompts');
  return res.json();
}

async function deleteProfile(id: string) {
  const res = await fetch(`/api/profiles/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete profile');
}

// Provider Config API functions
async function fetchProviderConfigs(profileId: string): Promise<ProviderConfig[]> {
  const res = await fetch(`/api/profiles/${profileId}/provider-configs`);
  if (!res.ok) throw new Error('Failed to fetch provider configs');
  return res.json();
}

async function createProviderConfig(
  profileId: string,
  data: {
    providerId: string;
    name?: string;
    description?: string | null;
    options?: string | null;
    env?: Record<string, string> | null;
    model?: string | null;
    effort?: string | null;
  },
): Promise<ProviderConfig> {
  const res = await fetch(`/api/profiles/${profileId}/provider-configs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.message || 'Failed to create provider config');
  }
  return res.json();
}

async function updateProviderConfig(
  id: string,
  data: {
    name?: string;
    description?: string | null;
    options?: string | null;
    env?: Record<string, string> | null;
    model?: string | null;
    effort?: string | null;
  },
): Promise<ProviderConfig> {
  const res = await fetch(`/api/provider-configs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.message || 'Failed to update provider config');
  }
  return res.json();
}

async function deleteProviderConfig(id: string): Promise<void> {
  const res = await fetch(`/api/provider-configs/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.message || 'Failed to delete provider config');
  }
}

interface ProviderCatalogModel {
  name: string;
}

interface ProviderEffortsCatalog {
  efforts: Array<{ name: string }>;
  supportsEffort: boolean;
  requiresModelForEffort: boolean;
}

async function fetchProviderModels(providerId: string): Promise<ProviderCatalogModel[]> {
  const res = await fetch(`/api/providers/${encodeURIComponent(providerId)}/models`);
  if (!res.ok) throw new Error('Failed to fetch provider models');
  return res.json();
}

async function fetchProviderEfforts(providerId: string): Promise<ProviderEffortsCatalog> {
  const res = await fetch(`/api/providers/${encodeURIComponent(providerId)}/efforts`);
  if (!res.ok) throw new Error('Failed to fetch provider efforts');
  return res.json();
}

// Detect whether raw options text carries a conflicting flag for a structured
// selection. Intentionally simple string/flag matching (full options parsing is
// a registered backlog item).
const MODEL_FLAG_RES = /(^|\s)--model(=|\s)|(^|\s)-m(\s)/;
const EFFORT_FLAG_RES =
  /(^|\s)--effort(=|\s)|(^|\s)--reasoning-effort(=|\s)|-c\s+model_reasoning_effort=/;

function hasModelFlagConflict(options: string, model: string | null): boolean {
  return model != null && MODEL_FLAG_RES.test(options);
}

function hasEffortFlagConflict(options: string, effort: string | null): boolean {
  return effort != null && EFFORT_FLAG_RES.test(options);
}

// Structured Model + Effort selectors with a non-blocking conflict warning.
// Used by both the create and edit config paths.
export function ProviderConfigDefaultsFields({
  providerId,
  model,
  effort,
  options,
  onModelChange,
  onEffortChange,
}: {
  providerId: string;
  model: string | null;
  effort: string | null;
  options: string;
  onModelChange: (value: string | null) => void;
  onEffortChange: (value: string | null) => void;
}) {
  const { data: models } = useQuery({
    queryKey: ['provider-models', providerId],
    queryFn: () => fetchProviderModels(providerId),
    enabled: !!providerId,
  });

  const { data: effortsCatalog } = useQuery({
    queryKey: ['provider-efforts', providerId],
    queryFn: () => fetchProviderEfforts(providerId),
    enabled: !!providerId,
  });

  const supportsEffort = effortsCatalog?.supportsEffort ?? false;
  const efforts = effortsCatalog?.efforts ?? [];
  const modelOptions = models ?? [];

  const modelConflict = hasModelFlagConflict(options, model);
  const effortConflict = hasEffortFlagConflict(options, effort);
  const showWarning = modelConflict || effortConflict;

  const selectClass =
    'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm';

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Model</Label>
          <select
            value={model ?? ''}
            onChange={(e) => onModelChange(e.target.value || null)}
            className={selectClass}
            aria-label="Structured model default"
          >
            <option value="">None (use raw options)</option>
            {modelOptions.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        {supportsEffort && (
          <div>
            <Label className="text-xs">Effort</Label>
            <select
              value={effort ?? ''}
              onChange={(e) => onEffortChange(e.target.value || null)}
              className={selectClass}
              disabled={efforts.length === 0}
              aria-label="Structured effort default"
            >
              <option value="">None (use raw options)</option>
              {efforts.map((e) => (
                <option key={e.name} value={e.name}>
                  {e.name}
                </option>
              ))}
            </select>
            {efforts.length === 0 && (
              <p className="text-xs text-muted-foreground mt-1">No effort levels configured</p>
            )}
          </div>
        )}
      </div>
      {showWarning && (
        <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-500">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            The flag in options will be overridden by the structured selection
            {modelConflict && effortConflict ? 's' : ''}.
          </span>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Precedence: agent override → these structured defaults → raw options flags.
      </p>
    </div>
  );
}

// Drag and Drop Prompt List Component
function PromptOrderList({
  prompts,
  orderedPromptIds,
  onReorder,
}: {
  prompts: Prompt[];
  orderedPromptIds: string[];
  onReorder: (ids: string[]) => void;
}) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  const orderedPrompts = orderedPromptIds
    .map((id) => prompts.find((p) => p.id === id))
    .filter((p): p is Prompt => p !== undefined);

  const handleDragStart = (index: number) => {
    setDraggedIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;

    const newOrder = [...orderedPromptIds];
    const [removed] = newOrder.splice(draggedIndex, 1);
    newOrder.splice(index, 0, removed);

    setDraggedIndex(index);
    onReorder(newOrder);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
  };

  const moveUp = (index: number) => {
    if (index === 0) return;
    const newOrder = [...orderedPromptIds];
    [newOrder[index - 1], newOrder[index]] = [newOrder[index], newOrder[index - 1]];
    onReorder(newOrder);
    setFocusedIndex(index - 1);
  };

  const moveDown = (index: number) => {
    if (index === orderedPromptIds.length - 1) return;
    const newOrder = [...orderedPromptIds];
    [newOrder[index], newOrder[index + 1]] = [newOrder[index + 1], newOrder[index]];
    onReorder(newOrder);
    setFocusedIndex(index + 1);
  };

  const handleRemove = (index: number) => {
    const newOrder = [...orderedPromptIds];
    newOrder.splice(index, 1);
    onReorder(newOrder);
  };

  if (orderedPrompts.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-4 border rounded-md">
        No prompts assigned. Select prompts below to add them.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {orderedPrompts.map((prompt, index) => (
        <div
          key={prompt.id}
          draggable
          onDragStart={() => handleDragStart(index)}
          onDragOver={(e) => handleDragOver(e, index)}
          onDragEnd={handleDragEnd}
          className={cn(
            'flex items-center gap-2 p-3 border rounded-md bg-card cursor-move transition-colors',
            draggedIndex === index && 'opacity-50',
            focusedIndex === index && 'ring-2 ring-ring',
          )}
        >
          <GripVertical className="h-4 w-4 text-muted-foreground" />
          <div className="flex-1">
            <div className="font-medium text-sm">{prompt.title}</div>
            <div className="text-xs text-muted-foreground">Order: {index + 1}</div>
          </div>
          <div className="flex gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => moveUp(index)}
              disabled={index === 0}
              aria-label="Move up"
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => moveDown(index)}
              disabled={index === orderedPrompts.length - 1}
              aria-label="Move down"
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => handleRemove(index)}
              aria-label="Remove"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

// Provider Configs Section for a Profile
function ProviderConfigsSection({
  profileId,
  providers,
  providersById,
  onConfigChange,
}: {
  profileId: string;
  providers: Provider[];
  providersById: Map<string, Provider>;
  onConfigChange?: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast, showSuccess, showError } = useToastHelpers();
  const [expanded, setExpanded] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingConfigId, setEditingConfigId] = useState<string | null>(null);
  const [localConfigIds, setLocalConfigIds] = useState<string[]>([]);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [pendingDeleteConfig, setPendingDeleteConfig] = useState<ProviderConfig | null>(null);
  const createEnvEditorRef = useRef<EnvEditorHandle>(null);
  const editEnvEditorRef = useRef<EnvEditorHandle>(null);
  const [formData, setFormData] = useState({
    providerId: '',
    name: '',
    description: '',
    options: '',
    env: {} as Record<string, string>,
    model: null as string | null,
    effort: null as string | null,
  });

  const { data: configs, isLoading } = useQuery({
    queryKey: ['provider-configs', profileId],
    queryFn: () => fetchProviderConfigs(profileId),
    enabled: !!profileId,
  });

  // Sync local order with fetched data
  useEffect(() => {
    if (configs) {
      setLocalConfigIds(configs.map((c) => c.id));
    }
  }, [configs]);

  const createMutation = useMutation({
    mutationFn: (data: {
      providerId: string;
      name?: string;
      description?: string | null;
      options?: string | null;
      env?: Record<string, string> | null;
      model?: string | null;
      effort?: string | null;
    }) => createProviderConfig(profileId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['provider-configs', profileId] });
      setShowAddForm(false);
      resetForm();
      showSuccess({ title: 'Success', description: 'Provider configuration created' });
      onConfigChange?.();
    },
    onError: (error) => {
      showError({
        title: 'Error',
        description: getErrorMessage(error, 'Failed to create configuration'),
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      oldName: string;
      data: {
        name?: string;
        description?: string | null;
        options?: string | null;
        env?: Record<string, string> | null;
        model?: string | null;
        effort?: string | null;
      };
    }) => updateProviderConfig(id, data),
    onSuccess: (updatedConfig, variables) => {
      queryClient.invalidateQueries({ queryKey: ['provider-configs', profileId] });
      if (variables.oldName.trim() !== updatedConfig.name.trim()) {
        queryClient.invalidateQueries({
          predicate: (query) => query.queryKey[0] === 'project-presets',
        });
        queryClient.invalidateQueries({
          predicate: (query) => {
            const [key, , profileIds] = query.queryKey;
            return (
              key === 'provider-configs-by-profile' &&
              Array.isArray(profileIds) &&
              profileIds.includes(profileId)
            );
          },
        });
      }
      setEditingConfigId(null);
      resetForm();
      showSuccess({ title: 'Success', description: 'Provider configuration updated' });
      onConfigChange?.();
    },
    onError: (error) => {
      showError({
        title: 'Error',
        description: getErrorMessage(error, 'Failed to update configuration'),
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteProviderConfig,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['provider-configs', profileId] });
      showSuccess({ title: 'Success', description: 'Provider configuration deleted' });
      onConfigChange?.();
    },
    onError: (error) => {
      showError({
        title: 'Error',
        description: getErrorMessage(error, 'Failed to delete configuration'),
      });
    },
  });

  const reorderMutation = useMutation({
    mutationFn: async (configIds: string[]) => {
      const res = await fetch(`/api/profiles/${profileId}/provider-configs/order`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configIds }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Failed to reorder configurations');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['provider-configs', profileId] });
      showSuccess({ title: 'Success', description: 'Provider configurations reordered' });
      onConfigChange?.();
    },
    onError: (error) => {
      showError({
        title: 'Error',
        description: getErrorMessage(error, 'Failed to reorder configurations'),
      });
      // Revert local order on error
      if (configs) {
        setLocalConfigIds(configs.map((c) => c.id));
      }
    },
  });

  const resetForm = () => {
    setFormData({
      providerId: '',
      name: '',
      description: '',
      options: '',
      env: {},
      model: null,
      effort: null,
    });
  };

  const handleCreate = () => {
    if (!formData.providerId) {
      toast({ title: 'Error', description: 'Please select a provider', variant: 'destructive' });
      return;
    }
    // Check for name conflict
    const trimmedName = formData.name.trim();
    if (trimmedName && configs?.some((c) => c.name === trimmedName)) {
      toast({
        title: 'Error',
        description: 'A configuration with this name already exists',
        variant: 'destructive',
      });
      return;
    }

    const committedEnv = createEnvEditorRef.current?.commitPending();
    if (committedEnv === null) return;
    const env = committedEnv ?? formData.env;

    createMutation.mutate({
      providerId: formData.providerId,
      name: trimmedName || undefined, // API will auto-generate if not provided
      description: formData.description.trim() || null,
      options: formData.options.trim() || null,
      env: Object.keys(env).length > 0 ? env : null,
      model: formData.model,
      effort: formData.effort,
    });
  };

  const handleUpdate = (config: ProviderConfig) => {
    // Check for name conflict (excluding the current config being edited)
    const trimmedName = formData.name.trim();
    if (trimmedName && configs?.some((c) => c.id !== config.id && c.name === trimmedName)) {
      toast({
        title: 'Error',
        description: 'A configuration with this name already exists',
        variant: 'destructive',
      });
      return;
    }

    const committedEnv = editEnvEditorRef.current?.commitPending();
    if (committedEnv === null) return;
    const env = committedEnv ?? formData.env;

    updateMutation.mutate({
      id: config.id,
      oldName: config.name,
      data: {
        name: trimmedName || undefined,
        description: formData.description.trim() || null,
        options: formData.options.trim() || null,
        env: Object.keys(env).length > 0 ? env : null,
        model: formData.model,
        effort: formData.effort,
      },
    });
  };

  const handleDelete = (config: ProviderConfig) => {
    setPendingDeleteConfig(config);
  };

  const handleConfirmDelete = () => {
    if (pendingDeleteConfig) {
      deleteMutation.mutate(pendingDeleteConfig.id);
    }
  };

  const handleEdit = (config: ProviderConfig) => {
    setEditingConfigId(config.id);
    setFormData({
      providerId: config.providerId,
      name: config.name || '',
      description: config.description || '',
      options: config.options || '',
      env: config.env || {},
      model: config.model ?? null,
      effort: config.effort ?? null,
    });
    setShowAddForm(false);
  };

  const handleCancelEdit = () => {
    setEditingConfigId(null);
    resetForm();
  };

  // Drag and drop handlers
  const handleDragStart = (index: number) => {
    setDraggedIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;

    const newOrder = [...localConfigIds];
    const [removed] = newOrder.splice(draggedIndex, 1);
    newOrder.splice(index, 0, removed);

    setLocalConfigIds(newOrder);
    setDraggedIndex(index);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    // Persist to server
    reorderMutation.mutate(localConfigIds);
  };

  const moveUp = (index: number) => {
    if (index === 0) return;
    const newOrder = [...localConfigIds];
    [newOrder[index - 1], newOrder[index]] = [newOrder[index], newOrder[index - 1]];
    setLocalConfigIds(newOrder);
    reorderMutation.mutate(newOrder);
  };

  const moveDown = (index: number) => {
    if (index === localConfigIds.length - 1) return;
    const newOrder = [...localConfigIds];
    [newOrder[index], newOrder[index + 1]] = [newOrder[index + 1], newOrder[index]];
    setLocalConfigIds(newOrder);
    reorderMutation.mutate(newOrder);
  };

  // Get ordered configs
  const orderedConfigs = localConfigIds
    .map((id) => configs?.find((c) => c.id === id))
    .filter((c): c is ProviderConfig => c !== undefined);

  // All providers are available (multiple configs per provider allowed since Phase 5)
  const availableProviders = providers;

  return (
    <div className="border rounded-lg">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Settings2 className="h-4 w-4" />
          <span className="font-medium">Provider Configurations</span>
          <Badge variant="secondary">{configs?.length || 0}</Badge>
        </div>
        {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>

      {expanded && (
        <div className="p-3 pt-0 space-y-3">
          {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}

          {orderedConfigs.length === 0 && !showAddForm && (
            <p className="text-sm text-muted-foreground py-2">
              No provider configurations. Add one to enable agent launching.
            </p>
          )}

          {/* Existing Configs */}
          {orderedConfigs.map((config, index) => (
            <div
              key={config.id}
              draggable={!reorderMutation.isPending}
              onDragStart={() => !reorderMutation.isPending && handleDragStart(index)}
              onDragOver={(e) => !reorderMutation.isPending && handleDragOver(e, index)}
              onDragEnd={handleDragEnd}
              className={cn(
                'group border rounded-md p-3 space-y-3 transition-colors',
                draggedIndex === index && 'opacity-50',
                reorderMutation.isPending && 'cursor-not-allowed opacity-70',
              )}
            >
              {editingConfigId === config.id ? (
                // Edit form
                <>
                  <div className="flex items-center gap-2">
                    <Badge>{providersById.get(config.providerId)?.name || 'Unknown'}</Badge>
                    <span className="text-sm text-muted-foreground">(editing)</span>
                  </div>
                  <div>
                    <Label className="text-xs">Name *</Label>
                    <Input
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      placeholder="e.g., claude-glm, claude-default"
                      className="text-sm h-9"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Description</Label>
                    <Textarea
                      value={formData.description}
                      onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                      placeholder="What this configuration is used for"
                      rows={2}
                      className="text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Options</Label>
                    <Textarea
                      value={formData.options}
                      onChange={(e) => setFormData({ ...formData, options: e.target.value })}
                      placeholder="--model claude-3 --max-tokens 4000"
                      rows={2}
                      className="text-sm"
                    />
                  </div>
                  <ProviderConfigDefaultsFields
                    providerId={formData.providerId}
                    model={formData.model}
                    effort={formData.effort}
                    options={formData.options}
                    onModelChange={(v) => setFormData({ ...formData, model: v })}
                    onEffortChange={(v) => setFormData({ ...formData, effort: v })}
                  />
                  <div>
                    <Label className="text-xs">Environment Variables</Label>
                    <EnvEditor
                      ref={editEnvEditorRef}
                      env={formData.env}
                      onChange={(env) => setFormData({ ...formData, env })}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => handleUpdate(config)}
                      disabled={updateMutation.isPending || !formData.name.trim()}
                    >
                      Save
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={handleCancelEdit}>
                      Cancel
                    </Button>
                  </div>
                </>
              ) : (
                // View mode
                <>
                  <div className="flex items-center gap-2">
                    <GripVertical className="h-4 w-4 text-muted-foreground cursor-move" />
                    <div className="flex-1 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{config.name}</span>
                        <Badge variant="outline" className="text-xs">
                          {providersById.get(config.providerId)?.name || 'Unknown'}
                        </Badge>
                      </div>
                      <div className="flex gap-1 relative">
                        <span className="absolute right-full mr-1 inline-flex items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => moveUp(index)}
                            disabled={index === 0 || reorderMutation.isPending}
                            aria-label="Move up"
                          >
                            <ArrowUp className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => moveDown(index)}
                            disabled={
                              index === orderedConfigs.length - 1 || reorderMutation.isPending
                            }
                            aria-label="Move down"
                          >
                            <ArrowDown className="h-4 w-4" />
                          </Button>
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => handleEdit(config)}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(config)}
                          disabled={deleteMutation.isPending}
                          aria-label={`Delete configuration ${config.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                  {config.description && (
                    <div className="text-sm text-muted-foreground">{config.description}</div>
                  )}
                  {config.options && (
                    <div className="text-sm">
                      <span className="text-muted-foreground">Options:</span>{' '}
                      <span className="font-mono">{config.options}</span>
                    </div>
                  )}
                  {config.env && Object.keys(config.env).length > 0 && (
                    <div className="text-sm">
                      <span className="text-muted-foreground">Env:</span>{' '}
                      <span className="font-mono">{Object.keys(config.env).join(', ')}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}

          {/* Add New Config Form */}
          {showAddForm && (
            <div className="border rounded-md p-3 space-y-3 bg-muted/30">
              <div>
                <Label className="text-xs">Provider *</Label>
                <select
                  value={formData.providerId}
                  onChange={(e) => {
                    const newProviderId = e.target.value;
                    const provider = providersById.get(newProviderId);
                    // Auto-suggest name based on provider
                    const suggestedName = provider?.name || '';
                    // Clear structured selections — catalogs rebind to the new provider
                    setFormData({
                      ...formData,
                      providerId: newProviderId,
                      name: suggestedName,
                      model: null,
                      effort: null,
                    });
                  }}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                >
                  <option value="">-- Select provider --</option>
                  {availableProviders.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-xs">Name</Label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g., claude-glm, claude-default (auto-generated if empty)"
                  className="text-sm h-9"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Unique name for this configuration. Leave empty to auto-generate.
                </p>
              </div>
              <div>
                <Label className="text-xs">Description</Label>
                <Textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="What this configuration is used for"
                  rows={2}
                  className="text-sm"
                />
              </div>
              <div>
                <Label className="text-xs">Options</Label>
                <Textarea
                  value={formData.options}
                  onChange={(e) => setFormData({ ...formData, options: e.target.value })}
                  placeholder="--model claude-3 --max-tokens 4000"
                  rows={2}
                  className="text-sm"
                />
              </div>
              <ProviderConfigDefaultsFields
                providerId={formData.providerId}
                model={formData.model}
                effort={formData.effort}
                options={formData.options}
                onModelChange={(v) => setFormData({ ...formData, model: v })}
                onEffortChange={(v) => setFormData({ ...formData, effort: v })}
              />
              <div>
                <Label className="text-xs">Environment Variables</Label>
                <EnvEditor
                  ref={createEnvEditorRef}
                  env={formData.env}
                  onChange={(env) => setFormData({ ...formData, env })}
                />
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={handleCreate}
                  disabled={
                    createMutation.isPending || !formData.providerId || !formData.name.trim()
                  }
                >
                  Add Configuration
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setShowAddForm(false);
                    resetForm();
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Add Button */}
          {!showAddForm && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setShowAddForm(true);
                setEditingConfigId(null);
                resetForm();
              }}
              className="w-full"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Provider Configuration
            </Button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={pendingDeleteConfig !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteConfig(null);
        }}
        title="Delete configuration?"
        description="Are you sure you want to delete this configuration?"
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
        loading={deleteMutation.isPending}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}

export function ProfilesPage() {
  const queryClient = useQueryClient();
  const { showError, showSuccess } = useToastHelpers();
  const { selectedProjectId } = useSelectedProject();
  const formDialog = useFormDialog<AgentProfile>();
  const deleteDialog = useConfirmDialog<AgentProfile>();
  const editingProfile = formDialog.isEdit ? formDialog.entity : null;
  const pendingDeleteProfile = deleteDialog.target;
  // Note: providerId and options removed in Phase 4
  // Provider configuration now managed via ProviderConfigsSection
  const [formData, setFormData] = useState({
    name: '',
    familySlug: '',
    instructions: '',
    orderedPromptIds: [] as string[],
  });

  const { data: profilesData, isLoading: profilesLoading } = useQuery({
    queryKey: ['profiles', selectedProjectId],
    queryFn: () => fetchProfiles(selectedProjectId as string),
    enabled: !!selectedProjectId,
  });

  const { data: promptsData } = useQuery({
    queryKey: ['prompts', selectedProjectId],
    queryFn: () => fetchPrompts(selectedProjectId as string),
    enabled: !!selectedProjectId,
  });

  const { data: providersData } = useQuery({
    queryKey: providersQueryKeys.list(),
    queryFn: fetchProviders,
  });

  const providersById = useMemo(() => {
    const map = new Map<string, Provider>();
    if (providersData?.items) {
      providersData.items.forEach((provider: Provider) => {
        map.set(provider.id, provider);
      });
    }
    return map;
  }, [providersData]);

  const profilesKey = ['profiles', selectedProjectId] as const;
  type ProfilesList = ListContainer<AgentProfile>;

  const createMutation = useCrudMutation<AgentProfile, Parameters<typeof createProfile>[0], void>({
    mutationFn: createProfile,
    optimistic: {
      queryKey: profilesKey,
      // temp-id add — Profiles prepends the new row.
      project: (previous, newProfile) => {
        const list = previous as ProfilesList | undefined;
        if (!list) return previous;
        const optimistic: AgentProfile = {
          id: `temp-${Date.now()}`,
          name: newProfile.name,
          familySlug: newProfile.familySlug ?? null,
          instructions: newProfile.instructions ?? null,
          prompts: [],
          agentCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        return optimisticAdd(list, optimistic);
      },
    },
    toast: {
      error: (error) => ({
        title: 'Error',
        description: getErrorMessage(error, 'Failed to create profile'),
      }),
    },
    // Invalidate + success toast run AFTER the prompt-ordering chain: refetching
    // earlier would serve a list without the just-persisted prompt order. A
    // prompt-order failure is a soft warning — the dialog still closes and the
    // create itself is not rolled back.
    onSuccessSideEffects: async (created) => {
      try {
        if (formData.orderedPromptIds.length > 0 && created?.id) {
          await replaceProfilePrompts(created.id, formData.orderedPromptIds);
        }
      } catch (e) {
        showError({
          title: 'Warning',
          description: getErrorMessage(e, 'Failed to persist prompt ordering'),
        });
      } finally {
        queryClient.invalidateQueries({ queryKey: ['profiles', selectedProjectId] });
        formDialog.close();
        resetForm();
        showSuccess({
          title: 'Success',
          description: 'Profile created successfully',
        });
      }
    },
  });

  type UpdateProfileVars = {
    id: string;
    data: {
      name?: string;
      providerId?: string;
      familySlug?: string | null;
      options?: string | null;
      promptIds?: string[];
      instructions?: string | null;
    };
  };

  const updateMutation = useCrudMutation<unknown, UpdateProfileVars, void>({
    mutationFn: ({ id, data }) => updateProfile(id, data),
    optimistic: {
      queryKey: profilesKey,
      // in-place merge — same per-field precedence as before.
      project: (previous, { id, data }) => {
        const list = previous as ProfilesList | undefined;
        if (!list) return previous;
        return optimisticMergeById(list, id, (p: AgentProfile) => ({
          ...p,
          name: data.name ?? p.name,
          instructions:
            data.instructions !== undefined ? (data.instructions ?? null) : p.instructions,
          updatedAt: new Date().toISOString(),
        }));
      },
    },
    toast: {
      error: (error) => ({
        title: 'Error',
        description: getErrorMessage(error, 'Failed to update profile'),
      }),
    },
    // See createMutation: invalidate + success toast must follow the prompt chain.
    onSuccessSideEffects: async (_updated, variables) => {
      try {
        if (formData.orderedPromptIds.length >= 0 && variables?.id) {
          await replaceProfilePrompts(variables.id, formData.orderedPromptIds);
        }
      } catch (e) {
        showError({
          title: 'Warning',
          description: getErrorMessage(e, 'Failed to persist prompt ordering'),
        });
      } finally {
        queryClient.invalidateQueries({ queryKey: ['profiles', selectedProjectId] });
        formDialog.close();
        resetForm();
        showSuccess({
          title: 'Success',
          description: 'Profile updated successfully',
        });
      }
    },
  });

  const deleteMutation = useCrudMutation<void, string, void>({
    mutationFn: deleteProfile,
    optimistic: {
      queryKey: profilesKey,
      // filter-out.
      project: (previous, id) => {
        const list = previous as ProfilesList | undefined;
        if (!list) return previous;
        return optimisticRemoveById(list, id);
      },
    },
    invalidateKeys: [profilesKey],
    toast: {
      success: () => ({ title: 'Success', description: 'Profile deleted successfully' }),
      error: (error) => ({
        title: 'Error',
        description: getErrorMessage(error, 'Failed to delete profile'),
      }),
    },
  });

  const resetForm = () => {
    setFormData({
      name: '',
      familySlug: '',
      instructions: '',
      orderedPromptIds: [],
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProjectId) {
      showError({
        title: 'Error',
        description: 'Please select a project first',
      });
      return;
    }

    const instructionsValue =
      formData.instructions.trim().length > 0 ? formData.instructions : null;
    const familySlugValue = formData.familySlug.trim();
    const familySlugPayload = familySlugValue.length > 0 ? familySlugValue : null;

    if (editingProfile) {
      updateMutation.mutate({
        id: editingProfile.id,
        data: {
          name: formData.name,
          familySlug: familySlugPayload,
          promptIds: formData.orderedPromptIds,
          instructions: instructionsValue,
        },
      });
    } else {
      createMutation.mutate({
        projectId: selectedProjectId,
        name: formData.name,
        familySlug: familySlugPayload,
        promptIds: formData.orderedPromptIds,
        instructions: instructionsValue,
      });
    }
  };

  const handleEdit = (profile: AgentProfile) => {
    formDialog.openEdit(profile);
    setFormData({
      name: profile.name,
      familySlug: profile.familySlug ?? '',
      instructions: profile.instructions ?? '',
      orderedPromptIds: (profile.prompts || [])
        .sort((a, b) => a.order - b.order)
        .map((pp) => pp.promptId),
    });
  };

  const handleDelete = (profile: AgentProfile) => {
    const agentCount = profile.agentCount || 0;
    if (agentCount > 0) {
      showError({
        title: 'Cannot delete',
        description: `This profile is used by ${agentCount} agent(s). Remove agent assignments first.`,
      });
      return;
    }
    deleteDialog.open(profile);
  };

  const handleConfirmProfileDelete = () => {
    if (pendingDeleteProfile) {
      deleteMutation.mutate(pendingDeleteProfile.id);
    }
  };

  const availablePrompts = useMemo(() => {
    return promptsData?.items || [];
  }, [promptsData]);

  const unassignedPrompts = useMemo(() => {
    return availablePrompts.filter((p: Prompt) => !formData.orderedPromptIds.includes(p.id));
  }, [availablePrompts, formData.orderedPromptIds]);

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">Agent Profiles</h1>
        <Button
          onClick={() => {
            resetForm();
            formDialog.openCreate();
          }}
        >
          <Plus className="h-4 w-4 mr-2" />
          Create Profile
        </Button>
      </div>

      {profilesLoading && <p className="text-muted-foreground">Loading...</p>}

      {selectedProjectId && profilesData && (
        <div className="grid gap-4">
          {profilesData.items.map((profile: AgentProfile) => (
            <div key={profile.id} className="border rounded-lg p-4 bg-card">
              <div className="flex justify-between items-start mb-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-lg font-semibold">
                      {profile.name}
                      {profile.familySlug && (
                        <span className="ml-2 text-sm font-normal text-muted-foreground">
                          ({profile.familySlug})
                        </span>
                      )}
                    </h3>
                    {profile.provider?.name ? (
                      <Badge variant="secondary">{profile.provider.name}</Badge>
                    ) : (
                      <Badge variant="outline" className="text-amber-600 border-amber-400 gap-1">
                        <AlertCircle className="h-3 w-3" />
                        No provider config
                      </Badge>
                    )}
                    {/* Options are now managed via ProviderConfigsSection, not shown here */}
                    {profile.agentCount && profile.agentCount > 0 && (
                      <Badge variant="outline" className="gap-1">
                        <Users className="h-3 w-3" />
                        {profile.agentCount} agent{profile.agentCount !== 1 ? 's' : ''}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {(profile.prompts || []).length} prompt
                    {(profile.prompts || []).length !== 1 ? 's' : ''} assigned
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => handleEdit(profile)}>
                    Edit
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleDelete(profile)}
                    aria-label={`Delete profile ${profile.name}`}
                  >
                    Delete
                  </Button>
                </div>
              </div>
              {profile.prompts && profile.prompts.length > 0 && (
                <div className="mt-3 space-y-2">
                  <p className="text-sm font-medium">Prompts (in order):</p>
                  <div className="space-y-1">
                    {profile.prompts
                      .sort((a, b) => a.order - b.order)
                      .map((pp, idx) => (
                        <div
                          key={pp.promptId}
                          className="flex items-center gap-2 text-sm p-2 bg-muted/50 rounded"
                        >
                          <span className="text-muted-foreground">{idx + 1}.</span>
                          <span>{pp.prompt.title}</span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          ))}
          {profilesData.items.length === 0 && (
            <p className="text-center text-muted-foreground py-8">
              No profiles found. Create your first profile to get started.
            </p>
          )}
        </div>
      )}

      <Dialog open={formDialog.isOpen} onOpenChange={formDialog.onOpenChange}>
        <DialogContent className="max-w-5xl w-full max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingProfile ? 'Edit Profile' : 'Create Profile'}</DialogTitle>
            <DialogDescription>
              {editingProfile
                ? 'Update profile settings, prompt ordering, and instructions.'
                : 'Create a profile with prompts and instructions for agents.'}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-6 lg:grid-cols-[1fr_1.5fr]">
              {/* Left Column */}
              <div className="space-y-4">
                <div>
                  <Label htmlFor="name">Name *</Label>
                  <Input
                    id="name"
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    required
                    placeholder="Enter profile name"
                  />
                </div>

                <div>
                  <Label htmlFor="familySlug">Family Slug</Label>
                  <Input
                    id="familySlug"
                    type="text"
                    value={formData.familySlug}
                    onChange={(e) => setFormData({ ...formData, familySlug: e.target.value })}
                    placeholder="e.g., coder, architect"
                  />
                  <p className="mt-1 text-sm text-muted-foreground">
                    Groups equivalent profiles across providers. Profiles with the same family slug
                    can be switched between providers.
                  </p>
                </div>

                {/* Provider Configs Section - only show when editing */}
                {editingProfile && (
                  <ProviderConfigsSection
                    profileId={editingProfile.id}
                    providers={providersData?.items || []}
                    providersById={providersById}
                    onConfigChange={() => {
                      queryClient.invalidateQueries({ queryKey: ['profiles', selectedProjectId] });
                    }}
                  />
                )}

                <div>
                  <Label>Assigned Prompts (ordered)</Label>
                  <p className="text-sm text-muted-foreground mb-2">
                    Drag to reorder, or use arrow buttons for keyboard navigation
                  </p>
                  <PromptOrderList
                    prompts={availablePrompts}
                    orderedPromptIds={formData.orderedPromptIds}
                    onReorder={(ids) => setFormData({ ...formData, orderedPromptIds: ids })}
                  />
                </div>

                {unassignedPrompts.length > 0 && (
                  <div>
                    <Label>Add Prompts</Label>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      {unassignedPrompts.map((prompt: Prompt) => (
                        <button
                          key={prompt.id}
                          type="button"
                          onClick={() =>
                            setFormData({
                              ...formData,
                              orderedPromptIds: [...formData.orderedPromptIds, prompt.id],
                            })
                          }
                          className="text-left p-2 border rounded-md hover:bg-muted transition-colors text-sm"
                        >
                          {prompt.title}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Right Column - Instructions */}
              <div className="space-y-2">
                <Label htmlFor="instructions">Instructions</Label>
                <p className="text-sm text-muted-foreground">
                  Use <span className="font-mono">#</span> for grouped references and{' '}
                  <span className="font-mono">@</span> to search documents while you type.
                </p>
                <MarkdownReferenceInput
                  id="instructions"
                  value={formData.instructions}
                  onChange={(instructions) => setFormData({ ...formData, instructions })}
                  placeholder="Add guidance for this profile..."
                  rows={22}
                  projectId={selectedProjectId}
                />
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  formDialog.close();
                  resetForm();
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                {editingProfile ? 'Update' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleteDialog.isOpen}
        onOpenChange={deleteDialog.onOpenChange}
        title="Delete profile?"
        description="Are you sure you want to delete this profile?"
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
        loading={deleteMutation.isPending}
        onConfirm={handleConfirmProfileDelete}
      />
    </div>
  );
}
