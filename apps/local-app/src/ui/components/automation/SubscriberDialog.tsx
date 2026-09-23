import { useState, useEffect, useMemo } from 'react';
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
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { fetchStatuses } from '@/ui/pages/board/lib/board-api';
import {
  createSubscriber,
  updateSubscriber,
  fetchSubscribableEvents,
  type Subscriber,
  type CreateSubscriberData,
  type UpdateSubscriberData,
  type ActionInput as SubscriberActionInput,
  type EventFilterCondition,
  type EventFilter,
  type SubscribableEventDefinition,
} from '@/ui/lib/subscribers';
import { fetchWatchers, type Watcher } from '@/ui/lib/watchers';
import { fetchActions, type ActionMetadata } from '@/ui/lib/actions';
import {
  deliveryModeFromLegacyImmediate,
  isMessageDeliveryMode,
} from '@/modules/sessions/services/message-pool.types';
import { ActionInputsForm } from './ActionInputsForm';
import {
  findUnknownLabels,
  parseStatusLabels,
} from '@/modules/subscribers/actions/epic-status-guard';

type FilterOperator = EventFilterCondition['operator'];
type FilterCombinator = 'and' | 'or';

interface EventFilterRow {
  id: string;
  field: string;
  operator: FilterOperator;
  value: string;
}

interface FilterRowErrors {
  field?: string;
  value?: string;
}

let nextFilterRowId = 0;

function isZeroArgumentFilterOperator(operator: FilterOperator): boolean {
  return operator === 'is_null' || operator === 'is_not_null';
}

function normalizeFilterValue(operator: FilterOperator, value: string): string {
  return isZeroArgumentFilterOperator(operator) ? '' : value;
}

function removeFilterRowError(
  filterErrors: Record<string, FilterRowErrors>,
  rowId: string,
  field: keyof FilterRowErrors,
): Record<string, FilterRowErrors> {
  const rowErrors = filterErrors[rowId];
  if (!rowErrors?.[field]) return filterErrors;

  const nextRowErrors = { ...rowErrors };
  delete nextRowErrors[field];

  const nextFilterErrors = { ...filterErrors };
  if (!nextRowErrors.field && !nextRowErrors.value) {
    delete nextFilterErrors[rowId];
  } else {
    nextFilterErrors[rowId] = nextRowErrors;
  }
  return nextFilterErrors;
}

function createFilterRow(condition?: EventFilterCondition): EventFilterRow {
  nextFilterRowId += 1;
  const operator = condition?.operator || 'equals';
  return {
    id: `event-filter-row-${nextFilterRowId}`,
    field: condition?.field || '',
    operator,
    value: normalizeFilterValue(operator, condition?.value || ''),
  };
}

function hydrateEventFilter(eventFilter: EventFilter | null | undefined): {
  filterRows: EventFilterRow[];
  filterCombinator: FilterCombinator;
} {
  if (!eventFilter) {
    return { filterRows: [], filterCombinator: 'and' };
  }

  if ('field' in eventFilter) {
    return {
      filterRows: [createFilterRow(eventFilter)],
      filterCombinator: 'and',
    };
  }

  return {
    filterRows: eventFilter.filters.map((filter) => createFilterRow(filter)),
    filterCombinator: eventFilter.combinator,
  };
}

function serializeEventFilter(
  filterRows: EventFilterRow[],
  filterCombinator: FilterCombinator,
): EventFilter | null {
  const [first, ...rest] = filterRows.map(({ field, operator, value }) => ({
    field,
    operator,
    value: normalizeFilterValue(operator, value),
  }));
  if (!first) return null;
  return {
    combinator: rest.length === 0 ? 'and' : filterCombinator,
    filters: [first, ...rest],
  };
}

function normalizeSendMessageActionInputs(
  inputs: Record<string, SubscriberActionInput>,
  normalizeMissingDeliveryMode = false,
): Record<string, SubscriberActionInput> {
  let normalizedInputs = inputs;
  const explicit = inputs.deliveryMode;
  const explicitValue = explicit?.customValue;
  const hasLegacyInput = 'immediate' in inputs;

  if (!explicit && (hasLegacyInput || normalizeMissingDeliveryMode)) {
    normalizedInputs = {
      ...inputs,
      deliveryMode: {
        source: 'custom',
        customValue: deliveryModeFromLegacyImmediate(inputs.immediate?.customValue),
      },
    };
  }

  if (hasLegacyInput) {
    if (normalizedInputs === inputs) normalizedInputs = { ...inputs };
    delete normalizedInputs.immediate;
  }

  if (explicit && isMessageDeliveryMode(explicitValue) && explicit.source !== 'custom') {
    normalizedInputs = {
      ...normalizedInputs,
      deliveryMode: { source: 'custom', customValue: explicitValue },
    };
  }

  return normalizedInputs;
}

function sanitizeActionInputs(
  actionType: string,
  action: ActionMetadata | null,
  inputs: Record<string, SubscriberActionInput>,
  normalizeMissingDeliveryMode = false,
): Record<string, SubscriberActionInput> {
  const normalizedInputs =
    actionType === 'send_agent_message'
      ? normalizeSendMessageActionInputs(inputs, normalizeMissingDeliveryMode)
      : inputs;

  const allowedNames = action ? new Set(action.inputs.map((i) => i.name)) : null;

  let changed = normalizedInputs !== inputs;
  const next: Record<string, SubscriberActionInput> = {};

  for (const [name, value] of Object.entries(normalizedInputs)) {
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

function materializeActionInputDefaults(
  action: ActionMetadata | null,
  inputs: Record<string, SubscriberActionInput>,
): Record<string, SubscriberActionInput> {
  if (!action) return inputs;

  let next = inputs;
  for (const input of action.inputs) {
    if (input.defaultValue === undefined || input.name in inputs) continue;
    if (next === inputs) next = { ...inputs };
    next[input.name] = { source: 'custom', customValue: String(input.defaultValue) };
  }
  return next;
}

interface SubscriberFormData {
  name: string;
  description: string;
  enabled: boolean;
  eventName: string;
  filterRows: EventFilterRow[];
  filterCombinator: FilterCombinator;
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
  filterRows: [],
  filterCombinator: 'and',
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
  const apiFetch = useFetchFactory();
  const isEditMode = !!subscriber;

  const [formData, setFormData] = useState<SubscriberFormData>(defaultFormData);
  const [errors, setErrors] = useState<Partial<Record<keyof SubscriberFormData, string>>>({});
  const [filterErrors, setFilterErrors] = useState<Record<string, FilterRowErrors>>({});
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

  // Fetched on open (not on action selection) so an edit-mode save never races
  // the options it validates against. Shares the board's query key.
  const { data: statusesData } = useQuery({
    queryKey: ['statuses', selectedProjectId],
    queryFn: () => fetchStatuses(selectedProjectId as string, apiFetch),
    enabled: !!selectedProjectId && open,
  });

  // Hydrate project-sourced options before the inputs form renders; stored
  // values stay labels so they survive a template copy into another project.
  const hydratedAction = useMemo(() => {
    if (!selectedAction) return null;
    const statusOptions = [...(statusesData?.items ?? [])]
      .sort((left, right) => left.position - right.position)
      .map((status) => ({ value: status.label, label: status.label }));
    return {
      ...selectedAction,
      inputs: selectedAction.inputs.map((input) =>
        input.optionsSource === 'project_statuses' ? { ...input, options: statusOptions } : input,
      ),
    };
  }, [selectedAction, statusesData]);

  // Deletion must never persist an enabled retry. The action-type check covers the window
  // before metadata hydrates; supportsRetry=false covers any non-retryable action.
  const retryDisabled =
    formData.actionType === 'delete_agent' || selectedAction?.supportsRetry === false;

  // Reset form when dialog opens/closes or subscriber changes
  useEffect(() => {
    if (open) {
      if (subscriber) {
        const { filterRows, filterCombinator } = hydrateEventFilter(subscriber.eventFilter);
        setFormData({
          name: subscriber.name,
          description: subscriber.description || '',
          enabled: subscriber.enabled,
          eventName: subscriber.eventName,
          filterRows,
          filterCombinator,
          actionType: subscriber.actionType,
          actionInputs: sanitizeActionInputs(
            subscriber.actionType,
            null,
            (subscriber.actionInputs || {}) as Record<string, SubscriberActionInput>,
            true,
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
      setFilterErrors({});
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

  // Metadata loads async; clear a stored enabled retry once the selected action is
  // known to be non-retryable so it can never be saved back.
  useEffect(() => {
    if (!open || !retryDisabled || !formData.retryOnError) return;
    updateField('retryOnError', false);
  }, [open, retryDisabled, formData.retryOnError]);

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
    const newFilterErrors: Record<string, FilterRowErrors> = {};
    const newInputErrors: Record<string, string> = {};

    if (!formData.name.trim()) {
      newErrors.name = 'Name is required';
    } else if (formData.name.length > 100) {
      newErrors.name = 'Name must be 100 characters or less';
    }

    if (!formData.eventName.trim()) {
      newErrors.eventName = 'Event name is required';
    }

    for (const row of formData.filterRows) {
      const rowErrors: FilterRowErrors = {};
      if (!row.field.trim()) {
        rowErrors.field = 'Filter field is required';
      }
      if (!isZeroArgumentFilterOperator(row.operator) && !row.value.trim()) {
        rowErrors.value = 'Filter value is required';
      }
      if (Object.keys(rowErrors).length > 0) {
        newFilterErrors[row.id] = rowErrors;
      }
    }

    if (!formData.actionType) {
      newErrors.actionType = 'Action type is required';
    }

    // Validate required action inputs
    if (hydratedAction) {
      for (const input of hydratedAction.inputs) {
        const inputValue = formData.actionInputs[input.name];
        if (input.required) {
          if (!inputValue) {
            newInputErrors[input.name] = `${input.label} is required`;
          } else if (inputValue.source === 'custom' && !inputValue.customValue?.trim()) {
            newInputErrors[input.name] = `${input.label} is required`;
          } else if (inputValue.source === 'event_field' && !inputValue.eventField?.trim()) {
            newInputErrors[input.name] = `Please select an event field for ${input.label}`;
          }
        }

        if (
          inputValue &&
          input.allowedSources &&
          !input.allowedSources.includes(inputValue.source)
        ) {
          newInputErrors[input.name] = `${input.label} must use a custom value`;
        } else if (inputValue?.source === 'custom' && input.type === 'select' && input.multiple) {
          const unknownLabels = findUnknownLabels(
            parseStatusLabels(inputValue.customValue),
            input.options ?? [],
          );
          if (unknownLabels.length > 0) {
            newInputErrors[input.name] = `Unknown status: ${unknownLabels.join(', ')}`;
          }
        } else if (
          inputValue?.source === 'custom' &&
          input.type === 'select' &&
          input.options &&
          !input.options.some((option) => option.value === inputValue.customValue)
        ) {
          newInputErrors[input.name] = `Unsupported value for ${input.label}`;
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
    setFilterErrors(newFilterErrors);
    setInputErrors(newInputErrors);
    return (
      Object.keys(newErrors).length === 0 &&
      Object.keys(newFilterErrors).length === 0 &&
      Object.keys(newInputErrors).length === 0
    );
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

    const eventFilter = serializeEventFilter(formData.filterRows, formData.filterCombinator);
    const retryOnError = retryDisabled ? false : formData.retryOnError;

    if (isEditMode && subscriber) {
      const sanitizedActionInputs = sanitizeActionInputs(
        formData.actionType,
        selectedAction,
        materializeActionInputDefaults(selectedAction, formData.actionInputs),
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
        retryOnError,
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
        materializeActionInputDefaults(selectedAction, formData.actionInputs),
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
        retryOnError,
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

  const addFilterRow = () => {
    const row = createFilterRow();
    setFormData((prev) => ({ ...prev, filterRows: [...prev.filterRows, row] }));
  };

  const removeFilterRow = (rowId: string) => {
    setFormData((prev) => {
      const filterRows = prev.filterRows.filter((row) => row.id !== rowId);
      return {
        ...prev,
        filterRows,
        filterCombinator: filterRows.length === 0 ? 'and' : prev.filterCombinator,
      };
    });
    setFilterErrors((prev) => {
      const next = { ...prev };
      delete next[rowId];
      return next;
    });
  };

  const updateFilterRow = (rowId: string, field: 'field' | 'value', value: string) => {
    setFormData((prev) => ({
      ...prev,
      filterRows: prev.filterRows.map((row) =>
        row.id === rowId ? { ...row, [field]: value } : row,
      ),
    }));
    setFilterErrors((prev) => removeFilterRowError(prev, rowId, field));
  };

  const updateFilterOperator = (rowId: string, operator: FilterOperator) => {
    setFormData((prev) => ({
      ...prev,
      filterRows: prev.filterRows.map((row) =>
        row.id === rowId
          ? { ...row, operator, value: normalizeFilterValue(operator, row.value) }
          : row,
      ),
    }));

    if (isZeroArgumentFilterOperator(operator)) {
      setFilterErrors((prev) => removeFilterRowError(prev, rowId, 'value'));
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
                onValueChange={(value) => {
                  if (value) updateField('eventName', value);
                }}
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

            {formData.filterRows.length === 0 ? (
              <Button type="button" variant="outline" onClick={addFilterRow}>
                Add event filter
              </Button>
            ) : (
              <div className="space-y-3" aria-label="Event filters">
                {formData.filterRows.length > 1 && (
                  <div className="flex items-center gap-2">
                    <Label htmlFor="filter-combinator">Match</Label>
                    <Select
                      value={formData.filterCombinator}
                      onValueChange={(value: FilterCombinator) =>
                        updateField('filterCombinator', value)
                      }
                    >
                      <SelectTrigger id="filter-combinator" aria-label="Filter combination">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="and">Match all</SelectItem>
                        <SelectItem value="or">Match any</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {formData.filterRows.map((row, index) => {
                  const rowErrors = filterErrors[row.id] || {};
                  const fieldErrorId = `filter-field-error-${row.id}`;
                  const valueErrorId = `filter-value-error-${row.id}`;

                  return (
                    <div key={row.id} className="space-y-2 rounded-lg border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">Filter {index + 1}</p>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeFilterRow(row.id)}
                          aria-label={`Remove filter ${index + 1}`}
                        >
                          Remove filter
                        </Button>
                      </div>

                      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                        <div className="space-y-1">
                          <Label htmlFor={`filter-field-${row.id}`} className="text-xs">
                            Field
                          </Label>
                          <Input
                            id={`filter-field-${row.id}`}
                            value={row.field}
                            onChange={(e) => updateFilterRow(row.id, 'field', e.target.value)}
                            placeholder="sessionId"
                            className={rowErrors.field ? 'border-destructive' : ''}
                            aria-invalid={!!rowErrors.field}
                            aria-describedby={rowErrors.field ? fieldErrorId : undefined}
                          />
                          {rowErrors.field && (
                            <p id={fieldErrorId} className="text-sm text-destructive">
                              {rowErrors.field}
                            </p>
                          )}
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`filter-operator-${row.id}`} className="text-xs">
                            Operator
                          </Label>
                          <Select
                            value={row.operator}
                            onValueChange={(value: FilterOperator) =>
                              updateFilterOperator(row.id, value)
                            }
                          >
                            <SelectTrigger id={`filter-operator-${row.id}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="equals">Equals</SelectItem>
                              <SelectItem value="contains">Contains</SelectItem>
                              <SelectItem value="regex">Regex</SelectItem>
                              <SelectItem value="is_null">Is null</SelectItem>
                              <SelectItem value="is_not_null">Is not null</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        {isZeroArgumentFilterOperator(row.operator) ? (
                          <div className="space-y-1" aria-label="Filter value not required">
                            <Label className="text-xs">Value</Label>
                            <p className="text-sm text-muted-foreground">
                              Not required for this operator
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-1">
                            <Label htmlFor={`filter-value-${row.id}`} className="text-xs">
                              Value
                            </Label>
                            <Input
                              id={`filter-value-${row.id}`}
                              value={row.value}
                              onChange={(e) => updateFilterRow(row.id, 'value', e.target.value)}
                              placeholder="value"
                              className={rowErrors.value ? 'border-destructive' : ''}
                              aria-invalid={!!rowErrors.value}
                              aria-describedby={rowErrors.value ? valueErrorId : undefined}
                            />
                            {rowErrors.value && (
                              <p id={valueErrorId} className="text-sm text-destructive">
                                {rowErrors.value}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                <Button type="button" variant="outline" onClick={addFilterRow}>
                  Add another filter
                </Button>
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
                  <SelectTrigger
                    aria-label="Action type"
                    className={errors.actionType ? 'border-destructive' : ''}
                  >
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
                action={hydratedAction}
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
                checked={!retryDisabled && formData.retryOnError}
                onCheckedChange={(checked) => updateField('retryOnError', checked === true)}
                disabled={retryDisabled}
              />
              <Label htmlFor="retryOnError" className="cursor-pointer">
                Retry on error
              </Label>
            </div>
            {retryDisabled && (
              <p className="text-xs text-muted-foreground">
                Automatic retry is disabled for this action.
              </p>
            )}
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
