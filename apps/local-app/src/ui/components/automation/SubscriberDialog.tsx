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
  createSubscriber,
  updateSubscriber,
  fetchSubscribableEvents,
  type Subscriber,
  type CreateSubscriberData,
  type UpdateSubscriberData,
  type ActionInput as SubscriberActionInput,
  type EventFilter,
  type SubscribableEventDefinition,
} from '@/ui/lib/subscribers';
import { fetchWatchers, type Watcher } from '@/ui/lib/watchers';
import { fetchActions, type ActionMetadata } from '@/ui/lib/actions';
import { ActionInputsForm } from './ActionInputsForm';

type FilterOperator = 'equals' | 'contains' | 'regex';

function sanitizeActionInputs(
  actionType: string,
  action: ActionMetadata | null,
  inputs: Record<string, SubscriberActionInput>,
): Record<string, SubscriberActionInput> {
  const allowedNames = action ? new Set(action.inputs.map((i) => i.name)) : null;

  let changed = false;
  const next: Record<string, SubscriberActionInput> = {};

  for (const [name, value] of Object.entries(inputs)) {
    if (allowedNames && !allowedNames.has(name)) {
      changed = true;
      continue;
    }
    if (actionType === 'restart_agent' && name === 'agentId') {
      changed = true;
      continue;
    }
    next[name] = value;
  }

  return changed ? next : inputs;
}

interface SubscriberFormData {
  name: string;
  description: string;
  enabled: boolean;
  eventName: string;
  hasFilter: boolean;
  filterField: string;
  filterOperator: FilterOperator;
  filterValue: string;
  actionType: string;
  actionInputs: Record<string, SubscriberActionInput>;
  delayMs: number;
  cooldownMs: number;
  retryOnError: boolean;
  // Grouping & ordering
  groupName: string;
  priority: number;
  position: number;
}

const defaultFormData: SubscriberFormData = {
  name: '',
  description: '',
  enabled: true,
  eventName: '',
  hasFilter: false,
  filterField: '',
  filterOperator: 'equals',
  filterValue: '',
  actionType: '',
  actionInputs: {},
  delayMs: 0,
  cooldownMs: 5000,
  retryOnError: false,
  // Grouping & ordering
  groupName: '',
  priority: 0,
  position: 0,
};

interface SubscriberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subscriber?: Subscriber | null;
}

export function SubscriberDialog({ open, onOpenChange, subscriber }: SubscriberDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedProjectId } = useSelectedProject();
  const isEditMode = !!subscriber;

  const [formData, setFormData] = useState<SubscriberFormData>(defaultFormData);
  const [errors, setErrors] = useState<Partial<Record<keyof SubscriberFormData, string>>>({});
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});

  // Fetch subscribable events from catalog
  const { data: subscribableEvents } = useQuery({
    queryKey: ['subscribableEvents'],
    queryFn: fetchSubscribableEvents,
    enabled: open,
  });

  // Fetch watchers for event name suggestions (for terminal.watcher.triggered custom events)
  const { data: watchers } = useQuery({
    queryKey: ['watchers', selectedProjectId],
    queryFn: () => fetchWatchers(selectedProjectId as string),
    enabled: !!selectedProjectId && open,
  });

  // Fetch available actions
  const { data: actions, isLoading: actionsLoading } = useQuery({
    queryKey: ['actions'],
    queryFn: fetchActions,
    enabled: open,
  });

  // Get selected action metadata
  const selectedAction = actions?.find((a) => a.type === formData.actionType) || null;

  // Reset form when dialog opens/closes or subscriber changes
  useEffect(() => {
    if (open) {
      if (subscriber) {
        setFormData({
          name: subscriber.name,
          description: subscriber.description || '',
          enabled: subscriber.enabled,
          eventName: subscriber.eventName,
          hasFilter: !!subscriber.eventFilter,
          filterField: subscriber.eventFilter?.field || '',
          filterOperator: subscriber.eventFilter?.operator || 'equals',
          filterValue: subscriber.eventFilter?.value || '',
          actionType: subscriber.actionType,
          actionInputs: sanitizeActionInputs(
            subscriber.actionType,
            null,
            (subscriber.actionInputs || {}) as Record<string, SubscriberActionInput>,
          ),
          delayMs: subscriber.delayMs,
          cooldownMs: subscriber.cooldownMs,
          retryOnError: subscriber.retryOnError,
          // Grouping & ordering
          groupName: subscriber.groupName || '',
          priority: subscriber.priority ?? 0,
          position: subscriber.position ?? 0,
        });
      } else {
        setFormData(defaultFormData);
      }
      setErrors({});
      setInputErrors({});
    }
  }, [open, subscriber]);

  // If the action definition changes (or loads after initial render), drop any stored inputs
  // that are no longer part of the action contract (e.g., legacy restart_agent.agentId mapping).
  useEffect(() => {
    if (!formData.actionType || !open) return;
    const sanitized = sanitizeActionInputs(
      formData.actionType,
      selectedAction,
      formData.actionInputs,
    );
    if (sanitized !== formData.actionInputs) {
      updateField('actionInputs', sanitized);
      setInputErrors((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(prev)) {
          if (!(key in sanitized)) {
            delete next[key];
          }
        }
        return next;
      });
    }
  }, [open, formData.actionType, selectedAction]);

  // Clear invalid eventField selections when event changes
  useEffect(() => {
    if (!formData.eventName || !subscribableEvents) return;

    // Get valid field names for the selected event
    // Check if it's a system event
    const systemEvent = subscribableEvents.find((e) => e.name === formData.eventName);
    const eventFields = systemEvent
      ? systemEvent.fields
      : // If it's a watcher custom event, use terminal.watcher.triggered fields
        subscribableEvents.find((e) => e.name === 'terminal.watcher.triggered')?.fields || [];

    const validFields = new Set(eventFields.map((f) => f.field));
    if (validFields.size === 0) return;

    // Check if any actionInputs have invalid eventField references
    let hasInvalidFields = false;
    const updatedInputs = { ...formData.actionInputs };

    for (const [inputName, inputValue] of Object.entries(updatedInputs)) {
      if (inputValue.source === 'event_field' && inputValue.eventField) {
        if (!validFields.has(inputValue.eventField)) {
          // Clear invalid eventField selection
          updatedInputs[inputName] = {
            source: 'event_field',
            eventField: '',
            customValue: undefined,
          };
          hasInvalidFields = true;
        }
      }
    }

    if (hasInvalidFields) {
      setFormData((prev) => ({ ...prev, actionInputs: updatedInputs }));
    }
  }, [formData.eventName, formData.actionInputs, subscribableEvents]);

  // Create mutation
  const createMutation = useMutation({
    mutationFn: (data: CreateSubscriberData) => createSubscriber(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['subscribers', selectedProjectId] });
      onOpenChange(false);
      toast({
        title: 'Success',
        description: 'Subscriber created successfully',
      });
    },
    onError: (err) => {
      toast({
        title: 'Error',
        description: err instanceof Error ? err.message : 'Failed to create subscriber',
        variant: 'destructive',
      });
    },
  });

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateSubscriberData }) =>
      updateSubscriber(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['subscribers', selectedProjectId] });
      onOpenChange(false);
      toast({
        title: 'Success',
        description: 'Subscriber updated successfully',
      });
    },
    onError: (err) => {
      toast({
        title: 'Error',
        description: err instanceof Error ? err.message : 'Failed to update subscriber',
        variant: 'destructive',
      });
    },
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  const validate = (): boolean => {
    const newErrors: Partial<Record<keyof SubscriberFormData, string>> = {};
    const newInputErrors: Record<string, string> = {};

    if (!formData.name.trim()) {
      newErrors.name = 'Name is required';
    } else if (formData.name.length > 100) {
      newErrors.name = 'Name must be 100 characters or less';
    }

    if (!formData.eventName.trim()) {
      newErrors.eventName = 'Event name is required';
    }

    if (formData.hasFilter) {
      if (!formData.filterField.trim()) {
        newErrors.filterField = 'Filter field is required';
      }
      if (!formData.filterValue.trim()) {
        newErrors.filterValue = 'Filter value is required';
      }
    }

    if (!formData.actionType) {
      newErrors.actionType = 'Action type is required';
    }

    // Validate required action inputs
    if (selectedAction) {
      for (const input of selectedAction.inputs) {
        if (input.required) {
          const inputValue = formData.actionInputs[input.name];
          if (!inputValue) {
            newInputErrors[input.name] = `${input.label} is required`;
          } else if (inputValue.source === 'custom' && !inputValue.customValue?.trim()) {
            newInputErrors[input.name] = `${input.label} is required`;
          } else if (inputValue.source === 'event_field' && !inputValue.eventField?.trim()) {
            newInputErrors[input.name] = `Please select an event field for ${input.label}`;
          }
        }
      }
    }

    if (formData.delayMs < 0) {
      newErrors.delayMs = 'Delay must be 0 or greater';
    }

    if (formData.cooldownMs < 0) {
      newErrors.cooldownMs = 'Cooldown must be 0 or greater';
    }

    setErrors(newErrors);
    setInputErrors(newInputErrors);
    return Object.keys(newErrors).length === 0 && Object.keys(newInputErrors).length === 0;
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

    const eventFilter: EventFilter | null = formData.hasFilter
      ? {
          field: formData.filterField,
          operator: formData.filterOperator,
          value: formData.filterValue,
        }
      : null;

    if (isEditMode && subscriber) {
      const sanitizedActionInputs = sanitizeActionInputs(
        formData.actionType,
        selectedAction,
        formData.actionInputs,
      );
      const updateData: UpdateSubscriberData = {
        name: formData.name,
        description: formData.description || null,
        enabled: formData.enabled,
        eventName: formData.eventName,
        eventFilter,
        actionType: formData.actionType,
        actionInputs: sanitizedActionInputs,
        delayMs: formData.delayMs,
        cooldownMs: formData.cooldownMs,
        retryOnError: formData.retryOnError,
        // Grouping & ordering
        groupName: formData.groupName || null,
        priority: formData.priority,
        position: formData.position,
      };
      updateMutation.mutate({ id: subscriber.id, data: updateData });
    } else {
      const sanitizedActionInputs = sanitizeActionInputs(
        formData.actionType,
        selectedAction,
        formData.actionInputs,
      );
      const createData: CreateSubscriberData = {
        projectId: selectedProjectId,
        name: formData.name,
        description: formData.description || undefined,
        enabled: formData.enabled,
        eventName: formData.eventName,
        eventFilter,
        actionType: formData.actionType,
        actionInputs: sanitizedActionInputs,
        delayMs: formData.delayMs,
        cooldownMs: formData.cooldownMs,
        retryOnError: formData.retryOnError,
        // Grouping & ordering
        groupName: formData.groupName || null,
        priority: formData.priority,
        position: formData.position,
      };
      createMutation.mutate(createData);
    }
  };

  const updateField = <K extends keyof SubscriberFormData>(
    field: K,
    value: SubscriberFormData[K],
  ) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  // Get unique watcher custom event names (for terminal.watcher.triggered)
  const watcherEventNames = [...new Set(watchers?.map((w: Watcher) => w.eventName) || [])];

  // Group subscribable events by category for display
  const eventsByCategory = subscribableEvents?.reduce(
    (acc, event) => {
      if (!acc[event.category]) {
        acc[event.category] = [];
      }
      acc[event.category].push(event);
      return acc;
    },
    {} as Record<string, SubscribableEventDefinition[]>,
  );

  // Get fields for the currently selected event
  const getSelectedEventFields = () => {
    if (!formData.eventName || !subscribableEvents) return [];

    // Check if it's a system event
    const systemEvent = subscribableEvents.find((e) => e.name === formData.eventName);
    if (systemEvent) return systemEvent.fields;

    // If it's a watcher custom event, return terminal.watcher.triggered fields
    const watcherEvent = subscribableEvents.find((e) => e.name === 'terminal.watcher.triggered');
    return watcherEvent?.fields || [];
  };

  const selectedEventFields = getSelectedEventFields();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditMode ? 'Edit Subscriber' : 'Create Subscriber'}</DialogTitle>
          <DialogDescription>
            {isEditMode
              ? 'Update the subscriber configuration.'
              : 'Configure a new subscriber to react to events.'}
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
                placeholder="Error Handler"
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
                placeholder="Handles error events by sending a message"
                rows={2}
              />
            </div>
          </div>

          {/* Event Trigger */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Event Trigger
            </h3>
            <div className="space-y-2">
              <Label htmlFor="eventName">Event Name *</Label>
              <Select
                value={formData.eventName}
                onValueChange={(value) => updateField('eventName', value)}
              >
                <SelectTrigger className={errors.eventName ? 'border-destructive' : ''}>
                  <SelectValue placeholder="Select event type..." />
                </SelectTrigger>
                <SelectContent>
                  {/* System Events grouped by category */}
                  {eventsByCategory &&
                    Object.entries(eventsByCategory).map(([category, events]) => (
                      <div key={category}>
                        <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase">
                          {category}
                        </div>
                        {events.map((event) => (
                          <SelectItem key={event.name} value={event.name}>
                            {event.label}
                          </SelectItem>
                        ))}
                      </div>
                    ))}
                  {/* Watcher custom events (terminal.watcher.triggered events) */}
                  {watcherEventNames.length > 0 && (
                    <>
                      <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase border-t mt-1 pt-2">
                        Watcher Custom Events
                      </div>
                      {watcherEventNames.map((eventName) => (
                        <SelectItem key={eventName} value={eventName}>
                          {eventName}
                        </SelectItem>
                      ))}
                    </>
                  )}
                  {/* Show current value if custom */}
                  {formData.eventName &&
                    !subscribableEvents?.find((e) => e.name === formData.eventName) &&
                    !watcherEventNames.includes(formData.eventName) && (
                      <SelectItem value={formData.eventName}>
                        {formData.eventName} (custom)
                      </SelectItem>
                    )}
                </SelectContent>
              </Select>
              {errors.eventName && <p className="text-sm text-destructive">{errors.eventName}</p>}
              <Input
                placeholder="Or enter custom event name..."
                value={formData.eventName}
                onChange={(e) => updateField('eventName', e.target.value)}
                className="mt-2"
              />
              {selectedEventFields.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Available fields: {selectedEventFields.map((f) => f.field).join(', ')}
                </p>
              )}
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="hasFilter"
                checked={formData.hasFilter}
                onCheckedChange={(checked) => updateField('hasFilter', checked === true)}
              />
              <Label htmlFor="hasFilter" className="cursor-pointer">
                Add event filter
              </Label>
            </div>

            {formData.hasFilter && (
              <div className="grid grid-cols-3 gap-2 p-3 border rounded-lg">
                <div className="space-y-1">
                  <Label className="text-xs">Field</Label>
                  <Input
                    value={formData.filterField}
                    onChange={(e) => updateField('filterField', e.target.value)}
                    placeholder="sessionId"
                    className={errors.filterField ? 'border-destructive' : ''}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Operator</Label>
                  <Select
                    value={formData.filterOperator}
                    onValueChange={(value: FilterOperator) => updateField('filterOperator', value)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="equals">Equals</SelectItem>
                      <SelectItem value="contains">Contains</SelectItem>
                      <SelectItem value="regex">Regex</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Value</Label>
                  <Input
                    value={formData.filterValue}
                    onChange={(e) => updateField('filterValue', e.target.value)}
                    placeholder="value"
                    className={errors.filterValue ? 'border-destructive' : ''}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Action */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Action
            </h3>
            <div className="space-y-2">
              <Label>Action Type *</Label>
              {actionsLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading actions...
                </div>
              ) : (
                <Select
                  value={formData.actionType}
                  onValueChange={(value) => {
                    updateField('actionType', value);
                    // Reset action inputs when action type changes
                    updateField('actionInputs', {});
                  }}
                >
                  <SelectTrigger className={errors.actionType ? 'border-destructive' : ''}>
                    <SelectValue placeholder="Select action..." />
                  </SelectTrigger>
                  <SelectContent>
                    {actions?.map((action) => (
                      <SelectItem key={action.type} value={action.type}>
                        {action.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {errors.actionType && <p className="text-sm text-destructive">{errors.actionType}</p>}
            </div>

            {formData.actionType && (
              <ActionInputsForm
                action={selectedAction}
                values={formData.actionInputs}
                onChange={(values) => updateField('actionInputs', values)}
                availableEventFields={selectedEventFields}
                errors={inputErrors}
              />
            )}
          </div>

          {/* Execution Options */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Execution Options
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="delayMs">Delay Before Action (ms)</Label>
                <Input
                  id="delayMs"
                  type="number"
                  min={0}
                  step={100}
                  value={formData.delayMs}
                  onChange={(e) => updateField('delayMs', parseInt(e.target.value) || 0)}
                  className={errors.delayMs ? 'border-destructive' : ''}
                />
                {errors.delayMs && <p className="text-sm text-destructive">{errors.delayMs}</p>}
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
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="retryOnError"
                checked={formData.retryOnError}
                onCheckedChange={(checked) => updateField('retryOnError', checked === true)}
              />
              <Label htmlFor="retryOnError" className="cursor-pointer">
                Retry on error
              </Label>
            </div>
          </div>

          {/* Scheduling & Ordering */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Scheduling & Ordering
            </h3>
            <p className="text-xs text-muted-foreground">
              Delay schedules execution time. Priority and position break ties when multiple
              subscribers are due at the same time.
            </p>
            <div className="space-y-2">
              <Label htmlFor="groupName">Group Name (optional)</Label>
              <Input
                id="groupName"
                value={formData.groupName}
                onChange={(e) => updateField('groupName', e.target.value)}
                placeholder="Leave empty to group by event name"
              />
              <p className="text-xs text-muted-foreground">
                Subscribers in the same group are executed sequentially. Empty groups by event.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="priority">Priority</Label>
                <Input
                  id="priority"
                  type="number"
                  min={-100}
                  max={100}
                  value={formData.priority}
                  onChange={(e) => updateField('priority', parseInt(e.target.value) || 0)}
                />
                <p className="text-xs text-muted-foreground">
                  Higher priority runs first (-100 to 100)
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="position">Position</Label>
                <Input
                  id="position"
                  type="number"
                  min={0}
                  value={formData.position}
                  onChange={(e) => updateField('position', parseInt(e.target.value) || 0)}
                />
                <p className="text-xs text-muted-foreground">
                  Order within group when priority is equal
                </p>
              </div>
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
              Enable subscriber immediately
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
