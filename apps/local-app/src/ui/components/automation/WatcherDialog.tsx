import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Textarea } from '@/ui/components/ui/textarea';
import { Checkbox } from '@/ui/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { useToast } from '@/ui/hooks/use-toast';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import {
  createWatcher,
  updateWatcher,
  type Watcher,
  type CreateWatcherData,
  type UpdateWatcherData,
  type ConditionType,
  type TriggerCondition,
} from '@/ui/lib/watchers';

interface Agent {
  id: string;
  name: string;
}

interface Profile {
  id: string;
  name: string;
}

interface Provider {
  id: string;
  name: string;
}

type ScopeType = 'all' | 'agent' | 'profile' | 'provider';
type CooldownMode = 'time' | 'until_clear';

interface WatcherFormData {
  name: string;
  description: string;
  enabled: boolean;
  scope: ScopeType;
  scopeFilterId: string;
  pollIntervalMs: number;
  viewportLines: number;
  conditionType: ConditionType;
  conditionPattern: string;
  conditionFlags: string;
  idleAfterSeconds: number;
  cooldownMode: CooldownMode;
  cooldownMs: number;
  eventName: string;
}

const defaultFormData: WatcherFormData = {
  name: '',
  description: '',
  enabled: true,
  scope: 'all',
  scopeFilterId: '',
  pollIntervalMs: 5000,
  viewportLines: 50,
  conditionType: 'contains',
  conditionPattern: '',
  conditionFlags: '',
  idleAfterSeconds: 0,
  cooldownMode: 'time',
  cooldownMs: 30000,
  eventName: '',
};

interface WatcherDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  watcher?: Watcher | null;
}

async function fetchAgents(projectId: string): Promise<{ items: Agent[] }> {
  const res = await fetch(`/api/agents?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) throw new Error('Failed to fetch agents');
  return res.json();
}

async function fetchProfiles(projectId: string): Promise<{ items: Profile[] }> {
  const res = await fetch(`/api/profiles?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) throw new Error('Failed to fetch profiles');
  return res.json();
}

async function fetchProviders(): Promise<{ items: Provider[] }> {
  const res = await fetch('/api/providers');
  if (!res.ok) throw new Error('Failed to fetch providers');
  return res.json();
}

const EVENT_NAME_REGEX = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

export function WatcherDialog({ open, onOpenChange, watcher }: WatcherDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedProjectId } = useSelectedProject();
  const isEditMode = !!watcher;

  const [formData, setFormData] = useState<WatcherFormData>(defaultFormData);
  const [errors, setErrors] = useState<Partial<Record<keyof WatcherFormData, string>>>({});

  // Fetch scope options
  const { data: agentsData } = useQuery({
    queryKey: ['agents', selectedProjectId],
    queryFn: () => fetchAgents(selectedProjectId as string),
    enabled: !!selectedProjectId && open,
  });

  const { data: profilesData } = useQuery({
    queryKey: ['profiles', selectedProjectId],
    queryFn: () => fetchProfiles(selectedProjectId as string),
    enabled: !!selectedProjectId && open,
  });

  const { data: providersData } = useQuery({
    queryKey: ['providers'],
    queryFn: fetchProviders,
    enabled: open,
  });

  // Reset form when dialog opens/closes or watcher changes
  useEffect(() => {
    if (open) {
      if (watcher) {
        setFormData({
          name: watcher.name,
          description: watcher.description || '',
          enabled: watcher.enabled,
          scope: watcher.scope,
          scopeFilterId: watcher.scopeFilterId || '',
          pollIntervalMs: watcher.pollIntervalMs,
          viewportLines: watcher.viewportLines,
          conditionType: watcher.condition.type,
          conditionPattern: watcher.condition.pattern,
          conditionFlags: watcher.condition.flags || '',
          idleAfterSeconds: watcher.idleAfterSeconds ?? 0,
          cooldownMode: watcher.cooldownMode,
          cooldownMs: watcher.cooldownMs,
          eventName: watcher.eventName,
        });
      } else {
        setFormData(defaultFormData);
      }
      setErrors({});
    }
  }, [open, watcher]);

  // Create mutation
  const createMutation = useMutation({
    mutationFn: (data: CreateWatcherData) => createWatcher(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['watchers', selectedProjectId] });
      onOpenChange(false);
      toast({
        title: 'Success',
        description: 'Watcher created successfully',
      });
    },
    onError: (err) => {
      toast({
        title: 'Error',
        description: err instanceof Error ? err.message : 'Failed to create watcher',
        variant: 'destructive',
      });
    },
  });

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateWatcherData }) => updateWatcher(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['watchers', selectedProjectId] });
      onOpenChange(false);
      toast({
        title: 'Success',
        description: 'Watcher updated successfully',
      });
    },
    onError: (err) => {
      toast({
        title: 'Error',
        description: err instanceof Error ? err.message : 'Failed to update watcher',
        variant: 'destructive',
      });
    },
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  const validate = (): boolean => {
    const newErrors: Partial<Record<keyof WatcherFormData, string>> = {};

    if (!formData.name.trim()) {
      newErrors.name = 'Name is required';
    } else if (formData.name.length > 100) {
      newErrors.name = 'Name must be 100 characters or less';
    }

    if (formData.scope !== 'all' && !formData.scopeFilterId) {
      newErrors.scopeFilterId = `Please select a ${formData.scope}`;
    }

    if (formData.pollIntervalMs < 1000 || formData.pollIntervalMs > 60000) {
      newErrors.pollIntervalMs = 'Poll interval must be between 1000ms and 60000ms';
    }

    if (formData.viewportLines < 10 || formData.viewportLines > 200) {
      newErrors.viewportLines = 'Viewport lines must be between 10 and 200';
    }

    if (!formData.conditionPattern.trim()) {
      newErrors.conditionPattern = 'Pattern is required';
    }

    if (formData.conditionType === 'regex') {
      try {
        new RegExp(formData.conditionPattern, formData.conditionFlags);
      } catch {
        newErrors.conditionPattern = 'Invalid regular expression';
      }
    }

    if (formData.idleAfterSeconds < 0 || formData.idleAfterSeconds > 3600) {
      newErrors.idleAfterSeconds = 'Idle gate must be between 0 and 3600 seconds';
    }

    if (formData.cooldownMs < 0) {
      newErrors.cooldownMs = 'Cooldown must be 0 or greater';
    }

    if (!formData.eventName.trim()) {
      newErrors.eventName = 'Event name is required';
    } else if (!EVENT_NAME_REGEX.test(formData.eventName)) {
      newErrors.eventName =
        'Event name must be lowercase, start with letter, use dots for namespacing (e.g., watcher.error_detected)';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!validate()) return;
    if (!selectedProjectId) {
      toast({
        title: 'Error',
        description: 'Please select a project first',
        variant: 'destructive',
      });
      return;
    }

    const condition: TriggerCondition = {
      type: formData.conditionType,
      pattern: formData.conditionPattern,
    };
    if (formData.conditionType === 'regex' && formData.conditionFlags) {
      condition.flags = formData.conditionFlags;
    }

    if (isEditMode && watcher) {
      const updateData: UpdateWatcherData = {
        name: formData.name,
        description: formData.description || null,
        enabled: formData.enabled,
        scope: formData.scope,
        scopeFilterId: formData.scope === 'all' ? null : formData.scopeFilterId,
        pollIntervalMs: formData.pollIntervalMs,
        viewportLines: formData.viewportLines,
        condition,
        idleAfterSeconds: formData.idleAfterSeconds,
        cooldownMode: formData.cooldownMode,
        cooldownMs: formData.cooldownMs,
        eventName: formData.eventName,
      };
      updateMutation.mutate({ id: watcher.id, data: updateData });
    } else {
      const createData: CreateWatcherData = {
        projectId: selectedProjectId,
        name: formData.name,
        description: formData.description || undefined,
        enabled: formData.enabled,
        scope: formData.scope,
        scopeFilterId: formData.scope === 'all' ? null : formData.scopeFilterId,
        pollIntervalMs: formData.pollIntervalMs,
        viewportLines: formData.viewportLines,
        condition,
        idleAfterSeconds: formData.idleAfterSeconds,
        cooldownMode: formData.cooldownMode,
        cooldownMs: formData.cooldownMs,
        eventName: formData.eventName,
      };
      createMutation.mutate(createData);
    }
  };

  const updateField = <K extends keyof WatcherFormData>(field: K, value: WatcherFormData[K]) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  const getScopeOptions = () => {
    switch (formData.scope) {
      case 'agent':
        return agentsData?.items || [];
      case 'profile':
        return profilesData?.items || [];
      case 'provider':
        return providersData?.items || [];
      default:
        return [];
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditMode ? 'Edit Watcher' : 'Create Watcher'}</DialogTitle>
          <DialogDescription>
            {isEditMode
              ? 'Update the watcher configuration.'
              : 'Configure a new watcher to monitor terminal output.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Basic Info */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Basic Info
            </h3>
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => updateField('name', e.target.value)}
                placeholder="Error Detector"
                className={errors.name ? 'border-destructive' : ''}
              />
              {errors.name && <p className="text-sm text-destructive">{errors.name}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => updateField('description', e.target.value)}
                placeholder="Monitors for error messages in terminal output"
                rows={2}
              />
            </div>
          </div>

          {/* Scope */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Scope
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Monitor</Label>
                <Select
                  value={formData.scope}
                  onValueChange={(value: ScopeType) => {
                    updateField('scope', value);
                    updateField('scopeFilterId', '');
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Sessions</SelectItem>
                    <SelectItem value="agent">Specific Agent</SelectItem>
                    <SelectItem value="profile">Specific Profile</SelectItem>
                    <SelectItem value="provider">Specific Provider</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {formData.scope !== 'all' && (
                <div className="space-y-2">
                  <Label>
                    Select {formData.scope.charAt(0).toUpperCase() + formData.scope.slice(1)} *
                  </Label>
                  <Select
                    value={formData.scopeFilterId}
                    onValueChange={(value) => updateField('scopeFilterId', value)}
                  >
                    <SelectTrigger className={errors.scopeFilterId ? 'border-destructive' : ''}>
                      <SelectValue placeholder={`Select ${formData.scope}...`} />
                    </SelectTrigger>
                    <SelectContent>
                      {getScopeOptions().map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {errors.scopeFilterId && (
                    <p className="text-sm text-destructive">{errors.scopeFilterId}</p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Polling */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Polling
            </h3>
            <div className="grid gap-4 grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="pollInterval">Poll Interval (ms) *</Label>
                <Input
                  id="pollInterval"
                  type="number"
                  min={1000}
                  max={60000}
                  step={1000}
                  value={formData.pollIntervalMs}
                  onChange={(e) => updateField('pollIntervalMs', parseInt(e.target.value) || 5000)}
                  className={errors.pollIntervalMs ? 'border-destructive' : ''}
                />
                {errors.pollIntervalMs && (
                  <p className="text-sm text-destructive">{errors.pollIntervalMs}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="viewportLines">Viewport Lines *</Label>
                <Input
                  id="viewportLines"
                  type="number"
                  min={10}
                  max={200}
                  step={10}
                  value={formData.viewportLines}
                  onChange={(e) => updateField('viewportLines', parseInt(e.target.value) || 50)}
                  className={errors.viewportLines ? 'border-destructive' : ''}
                />
                {errors.viewportLines && (
                  <p className="text-sm text-destructive">{errors.viewportLines}</p>
                )}
              </div>
            </div>
          </div>

          {/* Trigger Condition */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Trigger Condition
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Condition Type</Label>
                <Select
                  value={formData.conditionType}
                  onValueChange={(value: ConditionType) => {
                    updateField('conditionType', value);
                    if (value !== 'regex') {
                      updateField('conditionFlags', '');
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="contains">Contains</SelectItem>
                    <SelectItem value="regex">Regex</SelectItem>
                    <SelectItem value="not_contains">Not Contains</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {formData.conditionType === 'regex' && (
                <div className="space-y-2">
                  <Label htmlFor="conditionFlags">Regex Flags</Label>
                  <Input
                    id="conditionFlags"
                    value={formData.conditionFlags}
                    onChange={(e) => updateField('conditionFlags', e.target.value)}
                    placeholder="gi"
                  />
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="conditionPattern">Pattern *</Label>
              <Input
                id="conditionPattern"
                value={formData.conditionPattern}
                onChange={(e) => {
                  updateField('conditionPattern', e.target.value);
                }}
                placeholder={
                  formData.conditionType === 'regex' ? 'error|exception|failed' : 'Error:'
                }
                className={errors.conditionPattern ? 'border-destructive' : ''}
              />
              {errors.conditionPattern && (
                <p className="text-sm text-destructive">{errors.conditionPattern}</p>
              )}
            </div>
          </div>

          {/* Cooldown */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Cooldown
            </h3>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label>Cooldown Mode</Label>
                <Select
                  value={formData.cooldownMode}
                  onValueChange={(value: CooldownMode) => updateField('cooldownMode', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="time">Time-based</SelectItem>
                    <SelectItem value="until_clear">Until Condition Clears</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cooldownMs">Cooldown (ms)</Label>
                <Input
                  id="cooldownMs"
                  type="number"
                  min={0}
                  step={1000}
                  value={formData.cooldownMs}
                  onChange={(e) => updateField('cooldownMs', parseInt(e.target.value) || 0)}
                  className={errors.cooldownMs ? 'border-destructive' : ''}
                />
                {errors.cooldownMs && (
                  <p className="text-sm text-destructive">{errors.cooldownMs}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="idleAfterSeconds">Only when idle for (seconds)</Label>
                <Input
                  id="idleAfterSeconds"
                  type="number"
                  min={0}
                  max={3600}
                  step={1}
                  value={formData.idleAfterSeconds}
                  onChange={(e) =>
                    updateField('idleAfterSeconds', parseInt(e.target.value, 10) || 0)
                  }
                  placeholder="0 = disabled"
                  className={errors.idleAfterSeconds ? 'border-destructive' : ''}
                />
                {errors.idleAfterSeconds && (
                  <p className="text-sm text-destructive">{errors.idleAfterSeconds}</p>
                )}
              </div>
            </div>
            {formData.idleAfterSeconds > 0 && (
              <p className="text-xs text-muted-foreground">
                Recommended: use &quot;Until Condition Clears&quot; cooldown mode for idle-gated
                watchers.
              </p>
            )}
          </div>

          {/* Event Output */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Event Output
            </h3>
            <div className="space-y-2">
              <Label htmlFor="eventName">Event Name *</Label>
              <Input
                id="eventName"
                value={formData.eventName}
                onChange={(e) => updateField('eventName', e.target.value)}
                placeholder="watcher.error_detected"
                className={errors.eventName ? 'border-destructive' : ''}
              />
              {errors.eventName && <p className="text-sm text-destructive">{errors.eventName}</p>}
              <p className="text-xs text-muted-foreground">
                Lowercase with dots for namespacing (e.g., watcher.build_failed)
              </p>
            </div>
          </div>

          {/* Enabled */}
          <div className="flex items-center space-x-2">
            <Checkbox
              id="enabled"
              checked={formData.enabled}
              onCheckedChange={(checked) => updateField('enabled', checked === true)}
            />
            <Label htmlFor="enabled" className="cursor-pointer">
              Enable watcher immediately
            </Label>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {isEditMode ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
