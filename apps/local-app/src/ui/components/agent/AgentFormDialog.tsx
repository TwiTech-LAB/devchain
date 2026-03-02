import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Textarea } from '@/ui/components/ui/textarea';
import { Label } from '@/ui/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/ui/components/ui/dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/ui/components/ui/avatar';
import { AlertCircle, Loader2 } from 'lucide-react';
import {
  getAgentAvatarAltText,
  getAgentAvatarDataUri,
  getAgentInitials,
} from '@/ui/lib/multiavatar';
import { providerModelQueryKeys } from '@/ui/lib/provider-model-query-keys';
import { shortModelName } from '@/ui/lib/model-utils';

// ============================================
// Types
// ============================================

export interface ProviderConfig {
  id: string;
  profileId: string;
  providerId: string;
  name: string;
  options: string | null;
  env: Record<string, string> | null;
}

export interface AgentProfile {
  id: string;
  name: string;
  providerId: string;
  provider?: {
    id: string;
    name: string;
  };
  promptCount?: number;
}

export interface Provider {
  id: string;
  name: string;
  binPath?: string | null;
}

export interface AgentFormValues {
  name: string;
  profileId: string;
  providerConfigId: string;
  description: string;
  modelOverride: string | null;
}

export interface AgentFormSubmitData {
  name: string;
  profileId: string;
  providerConfigId: string | null;
  description: string | null;
  modelOverride: string | null;
}

export interface AgentFormDialogProps {
  mode: 'create' | 'edit';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialValues?: AgentFormValues;
  /** Profile for the agent being edited (fallback when not in available profiles) */
  initialProfile?: AgentProfile;
  onSubmit: (data: AgentFormSubmitData) => void;
  isSubmitting: boolean;
  projectName?: string;
  profiles: AgentProfile[];
  providers: Map<string, Provider>;
  /** Existing agents for duplicate name check */
  existingAgents: Array<{ id: string; name: string }>;
  /** ID of agent being edited (excluded from duplicate check) */
  editAgentId?: string;
}

// ============================================
// Internal helpers
// ============================================

const EMPTY_FORM: AgentFormValues = {
  name: '',
  profileId: '',
  providerConfigId: '',
  description: '',
  modelOverride: null,
};

const DEFAULT_MODEL_OVERRIDE = '__default_model_override__';

interface ProviderModelOption {
  id: string;
  name: string;
}

async function fetchProviderConfigs(profileId: string): Promise<ProviderConfig[]> {
  const res = await fetch(`/api/profiles/${profileId}/provider-configs`);
  if (!res.ok) throw new Error('Failed to fetch provider configs');
  return res.json();
}

function parseProviderModels(payload: unknown, providerId: string): ProviderModelOption[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map((rawModel, index) => {
      if (
        !rawModel ||
        typeof rawModel !== 'object' ||
        Array.isArray(rawModel) ||
        typeof (rawModel as { name?: unknown }).name !== 'string'
      ) {
        return null;
      }

      const model = rawModel as { id?: unknown; name: string };
      const name = model.name.trim();
      if (!name) {
        return null;
      }

      const id =
        typeof model.id === 'string' && model.id.trim().length > 0
          ? model.id
          : `${providerId}:${name}:${index}`;
      return { id, name };
    })
    .filter((model): model is ProviderModelOption => Boolean(model));
}

function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timeoutId = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timeoutId);
  }, [value, delay]);
  return debouncedValue;
}

function useAvatarPreview(name: string | null | undefined) {
  const debouncedName = useDebouncedValue(name ?? '', 250);
  return useMemo(() => {
    const normalized = debouncedName?.trim() ?? '';
    return {
      src: getAgentAvatarDataUri(normalized),
      alt: getAgentAvatarAltText(normalized),
      fallback: getAgentInitials(normalized),
      displayName: normalized || 'Avatar preview',
    };
  }, [debouncedName]);
}

// ============================================
// Component
// ============================================

export function AgentFormDialog({
  mode,
  open,
  onOpenChange,
  initialValues,
  initialProfile,
  onSubmit,
  isSubmitting,
  projectName,
  profiles,
  providers,
  existingAgents,
  editAgentId,
}: AgentFormDialogProps) {
  const isEdit = mode === 'edit';
  const idPrefix = isEdit ? 'edit-agent' : 'agent';
  const testIdPrefix = isEdit ? 'agent-preview-edit' : 'agent-preview-create';

  // ---- Form state ----
  const [formData, setFormData] = useState<AgentFormValues>(EMPTY_FORM);

  // Sync form state when dialog opens or initialValues change
  useEffect(() => {
    if (open) {
      setFormData({
        ...EMPTY_FORM,
        ...(initialValues ?? EMPTY_FORM),
        modelOverride: initialValues?.modelOverride ?? null,
      });
    }
  }, [open, initialValues]);

  const preview = useAvatarPreview(formData.name);

  // ---- Provider configs query ----
  const { data: providerConfigs } = useQuery({
    queryKey: ['provider-configs', formData.profileId],
    queryFn: () => fetchProviderConfigs(formData.profileId),
    enabled: !!formData.profileId,
  });

  const selectedProviderId = useMemo(() => {
    if (!providerConfigs || !formData.providerConfigId) return null;
    return (
      providerConfigs.find((config) => config.id === formData.providerConfigId)?.providerId ?? null
    );
  }, [providerConfigs, formData.providerConfigId]);

  const { data: providerModels = [], isLoading: isProviderModelsLoading } = useQuery({
    queryKey: providerModelQueryKeys.main(selectedProviderId ?? 'none'),
    queryFn: async () => {
      if (!selectedProviderId) return [] as ProviderModelOption[];
      const res = await fetch(`/api/providers/${selectedProviderId}/models`);
      if (!res.ok) return [] as ProviderModelOption[];
      const payload = (await res.json().catch(() => [])) as unknown;
      return parseProviderModels(payload, selectedProviderId);
    },
    enabled: !!selectedProviderId,
    staleTime: 5 * 60 * 1000,
  });

  // Auto-select config when profile changes
  useEffect(() => {
    if (providerConfigs === undefined) return;

    if (providerConfigs.length === 1) {
      const singleConfigId = providerConfigs[0].id;
      setFormData((prev) => {
        if (prev.providerConfigId === singleConfigId) {
          return prev;
        }
        return {
          ...prev,
          providerConfigId: singleConfigId,
          modelOverride: null,
        };
      });
      return;
    }

    if (providerConfigs.length === 0) {
      setFormData((prev) => {
        if (prev.providerConfigId === '' && prev.modelOverride === null) {
          return prev;
        }
        return { ...prev, providerConfigId: '', modelOverride: null };
      });
      return;
    }

    setFormData((prev) => {
      if (!prev.providerConfigId) {
        return prev;
      }
      const stillValid = providerConfigs.some((config) => config.id === prev.providerConfigId);
      if (stillValid) {
        return prev;
      }
      return { ...prev, providerConfigId: '', modelOverride: null };
    });
  }, [providerConfigs]);

  useEffect(() => {
    if (!selectedProviderId) return;
    if (isProviderModelsLoading) return;
    if (!formData.modelOverride) return;
    const hasSelectedModel = providerModels.some((model) => model.name === formData.modelOverride);
    if (!hasSelectedModel) {
      setFormData((prev) => ({ ...prev, modelOverride: null }));
    }
  }, [selectedProviderId, providerModels, formData.modelOverride, isProviderModelsLoading]);

  // ---- Duplicate name check ----
  const isDuplicateName = useMemo(() => {
    const trimmedName = formData.name.trim().toLowerCase();
    if (!trimmedName) return false;
    return existingAgents.some(
      (agent) =>
        agent.name.trim().toLowerCase() === trimmedName &&
        (!editAgentId || agent.id !== editAgentId),
    );
  }, [formData.name, existingAgents, editAgentId]);

  // ---- Edit-mode profile fallback ----
  const hasSelectedProfileOption = formData.profileId
    ? profiles.some((p) => p.id === formData.profileId)
    : false;

  // ---- Handlers ----
  const handleProfileChange = (profileId: string) => {
    setFormData((prev) => ({ ...prev, profileId, providerConfigId: '', modelOverride: null }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = formData.name.trim();
    if (!trimmedName) return;
    onSubmit({
      name: trimmedName,
      profileId: formData.profileId,
      providerConfigId: formData.providerConfigId || null,
      description: formData.description.trim() || null,
      modelOverride: formData.modelOverride || null,
    });
  };

  const handleCancel = () => {
    if (!isEdit) {
      setFormData(EMPTY_FORM);
    }
    onOpenChange(false);
  };

  const hasNoConfigs = formData.profileId && providerConfigs && providerConfigs.length === 0;
  const isSubmitDisabled = isSubmitting || isDuplicateName || !!hasNoConfigs;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Agent' : 'Create Agent'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? `Update the agent details for ${projectName ?? 'this project'}`
              : `Create a new agent for ${projectName ?? 'this project'}`}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name field */}
          <div>
            <Label htmlFor={`${idPrefix}-name`}>Name *</Label>
            <Input
              id={`${idPrefix}-name`}
              type="text"
              value={formData.name}
              onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
              required
              placeholder="Enter agent name"
              aria-invalid={isDuplicateName}
            />
            {isDuplicateName && (
              <p className="text-sm text-destructive mt-1">
                An agent with this name already exists in this project.
              </p>
            )}
          </div>

          {/* Avatar preview */}
          <div className="flex items-center gap-3 rounded-md border border-dashed border-muted p-3">
            <Avatar
              data-testid={`${testIdPrefix}-avatar`}
              className="h-12 w-12 border border-border"
              aria-label={preview.alt}
              title={preview.alt}
            >
              {preview.src ? (
                <AvatarImage
                  src={preview.src}
                  alt={preview.alt}
                  data-testid={`${testIdPrefix}-image`}
                />
              ) : null}
              <AvatarFallback className="uppercase tracking-wide">
                {preview.fallback}
              </AvatarFallback>
            </Avatar>
            <div className="space-y-1">
              <p className="text-sm font-medium" data-testid={`${testIdPrefix}-label`}>
                {preview.displayName}
              </p>
              <p className="text-xs text-muted-foreground">
                {isEdit
                  ? 'Preview updates after you pause typing.'
                  : 'Deterministic avatar updates after a short pause.'}
              </p>
            </div>
          </div>

          {/* Profile select */}
          <div>
            <Label htmlFor={`${idPrefix}-profile`}>Profile *</Label>
            <select
              id={`${idPrefix}-profile`}
              value={formData.profileId}
              onChange={(e) => handleProfileChange(e.target.value)}
              required
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">-- Select a profile --</option>
              {/* Edit-mode fallback: show current profile if not in available list */}
              {isEdit && !hasSelectedProfileOption && formData.profileId && initialProfile && (
                <option value={formData.profileId}>
                  {initialProfile.name}
                  {initialProfile.provider?.name
                    ? ` (${initialProfile.provider.name.toUpperCase()})`
                    : ''}
                </option>
              )}
              {profiles.map((profile) => {
                const providerName = profile.provider?.name || '';
                return (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                    {providerName ? ` (${providerName.toUpperCase()})` : ''}
                  </option>
                );
              })}
            </select>
            {profiles.length === 0 && (
              <p className="text-sm text-muted-foreground mt-1">
                No profiles available. Create a profile first.
              </p>
            )}
          </div>

          {/* Provider Config Selector */}
          {formData.profileId && (
            <div>
              <Label htmlFor={`${idPrefix}-config`}>
                Provider Configuration {providerConfigs && providerConfigs.length > 0 ? '*' : ''}
              </Label>
              <select
                id={`${idPrefix}-config`}
                value={formData.providerConfigId}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    providerConfigId: e.target.value,
                    modelOverride: null,
                  }))
                }
                required={providerConfigs && providerConfigs.length > 0}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">-- Select a configuration --</option>
                {providerConfigs?.map((config) => {
                  const provider = providers.get(config.providerId);
                  const hasEnv = config.env && Object.keys(config.env).length > 0;
                  const providerSuffix =
                    provider?.name && provider.name !== config.name ? ` (${provider.name})` : '';
                  return (
                    <option key={config.id} value={config.id}>
                      {config.name}
                      {providerSuffix}
                      {hasEnv ? ' [env]' : ''}
                    </option>
                  );
                })}
              </select>
              {providerConfigs && providerConfigs.length === 0 && (
                <div className="mt-2 flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20">
                  <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                  <div className="text-sm">
                    <p className="font-medium text-destructive">No provider configurations</p>
                    <p className="text-muted-foreground">
                      This profile has no provider configurations. Go to{' '}
                      <span className="font-medium">Profiles → Edit</span> to add one
                      {!isEdit && ' before creating an agent'}.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Model Override Selector */}
          {formData.profileId && formData.providerConfigId && providerModels.length > 0 && (
            <div>
              <Label htmlFor={`${idPrefix}-model-override`}>Model Override</Label>
              <select
                id={`${idPrefix}-model-override`}
                value={formData.modelOverride ?? DEFAULT_MODEL_OVERRIDE}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    modelOverride:
                      e.target.value === DEFAULT_MODEL_OVERRIDE ? null : e.target.value,
                  }))
                }
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value={DEFAULT_MODEL_OVERRIDE}>Default</option>
                {providerModels.map((model) => (
                  <option key={model.id} value={model.name} title={model.name}>
                    {shortModelName(model.name)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Description */}
          <div>
            <Label htmlFor={`${idPrefix}-description`}>Description (optional)</Label>
            <Textarea
              id={`${idPrefix}-description`}
              value={formData.description}
              onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
              placeholder="Enter agent description"
              rows={3}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleCancel}
              disabled={isEdit && isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitDisabled}>
              {isEdit && isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : isEdit ? (
                'Save changes'
              ) : (
                'Create'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
