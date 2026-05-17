import { useState, useEffect, useRef, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, ChevronsUpDown } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Textarea } from '@/ui/components/ui/textarea';
import { Switch } from '@/ui/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { useToast } from '@/ui/hooks/use-toast';
import { TimezoneSelector, getDetectedTimezone } from '@/ui/components/shared/TimezoneSelector';
import {
  createScheduledEpic,
  updateScheduledEpic,
  insertAtCursor,
  ScheduledEpicApiError,
  CRON_PRESETS,
  TEMPLATE_VARIABLES,
  type ScheduledEpic,
  type ScheduledEpicMissedRunPolicy,
  type CreateScheduledEpicData,
  type UpdateScheduledEpicData,
} from '@/ui/lib/scheduled-epics';
import { fetchStatuses, fetchAgents } from '@/ui/pages/board/lib/board-api';
import type { Status, Agent, Epic } from '@/ui/types';

interface ScheduleEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule?: ScheduledEpic | null;
  projectId: string;
}

interface FormData {
  name: string;
  cronExpression: string;
  cronMode: 'preset' | 'custom';
  timezone: string;
  enabled: boolean;
  titleTemplate: string;
  descriptionTemplate: string;
  templateStatusId: string;
  templateParentEpicId: string;
  templateAgentId: string;
  templateTags: string;
  allowOverlap: boolean;
  missedRunPolicy: ScheduledEpicMissedRunPolicy;
}

type FormErrors = Partial<Record<keyof FormData, string>>;

const STATUS_NULL_SENTINEL = '__project_default__';
const AGENT_NULL_SENTINEL = '__unassigned__';
const PARENT_NULL_SENTINEL = '__no_parent__';

function getDefaultFormData(): FormData {
  return {
    name: '',
    cronExpression: '0 9 * * *',
    cronMode: 'preset',
    timezone: getDetectedTimezone(),
    enabled: true,
    titleTemplate: '',
    descriptionTemplate: '',
    templateStatusId: '',
    templateParentEpicId: '',
    templateAgentId: '',
    templateTags: '',
    allowOverlap: false,
    missedRunPolicy: 'skip',
  };
}

function scheduleToFormData(schedule: ScheduledEpic): FormData {
  const isPreset = CRON_PRESETS.some((p) => p.expression === schedule.cronExpression);
  return {
    name: schedule.name,
    cronExpression: schedule.cronExpression,
    cronMode: isPreset ? 'preset' : 'custom',
    timezone: schedule.timezone,
    enabled: schedule.enabled,
    titleTemplate: schedule.titleTemplate,
    descriptionTemplate: schedule.descriptionTemplate ?? '',
    templateStatusId: schedule.templateStatusId ?? '',
    templateParentEpicId: schedule.templateParentEpicId ?? '',
    templateAgentId: schedule.templateAgentId ?? '',
    templateTags: schedule.templateTags.join(', '),
    allowOverlap: schedule.allowOverlap,
    missedRunPolicy: schedule.missedRunPolicy,
  };
}

function isUuidShaped(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// --- Variable Insertion Controls ---

interface InsertVariableControlProps {
  inputRef: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  value: string;
  onChange: (newValue: string) => void;
}

function InsertVariableControl({ inputRef, value, onChange }: InsertVariableControlProps) {
  const [open, setOpen] = useState(false);

  const handleInsert = (token: string) => {
    const input = inputRef.current;
    if (!input) {
      onChange(value + token);
      setOpen(false);
      return;
    }
    const { newValue, caretPosition } = insertAtCursor(input, value, token);
    onChange(newValue);
    setOpen(false);
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.setSelectionRange(caretPosition, caretPosition);
        inputRef.current.focus();
      }
    }, 0);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-muted-foreground"
          aria-label="Insert variable"
        >
          {'{{ }}'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1" align="start">
        <div className="space-y-0.5">
          {TEMPLATE_VARIABLES.map((v) => (
            <button
              key={v.token}
              type="button"
              className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => handleInsert(v.token)}
            >
              <span className="font-mono">{v.token}</span>
              <span className="ml-2 text-muted-foreground">{v.label}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// --- Parent Epic Picker ---

interface ParentEpicPickerProps {
  projectId: string;
  value: string;
  onChange: (id: string) => void;
  resolvedEpic: { id: string; title: string } | null;
  isResolving: boolean;
}

function ParentEpicPicker({
  projectId,
  value,
  onChange,
  resolvedEpic,
  isResolving,
}: ParentEpicPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [debouncedSearch]);

  const {
    data: searchData,
    isLoading: isSearching,
    isError: isSearchError,
  } = useQuery({
    queryKey: ['schedule-parent-epic-search', projectId, debouncedSearch],
    queryFn: async () => {
      const params = new URLSearchParams({ projectId, q: debouncedSearch, limit: '10' });
      const res = await fetch(`/api/epics?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to search epics');
      const data: { items: Epic[] } = await res.json();
      return data.items.filter((e) => e.parentId == null);
    },
    enabled: open && debouncedSearch.length > 0,
    staleTime: 30_000,
  });

  const results = searchData ?? [];

  const handleSelect = useCallback(
    (epic: Epic) => {
      onChange(epic.id);
      setOpen(false);
      setSearch('');
    },
    [onChange],
  );

  const handleClear = () => {
    onChange(PARENT_NULL_SENTINEL);
    setOpen(false);
    setSearch('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (results.length === 0) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (results[selectedIndex]) {
          handleSelect(results[selectedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
    }
  };

  const displayValue =
    value === PARENT_NULL_SENTINEL || !value
      ? 'No parent'
      : resolvedEpic
        ? resolvedEpic.title
        : isResolving
          ? 'Loading...'
          : `Unavailable: ${value.slice(0, 8)}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Select parent epic"
          className="w-full justify-between font-normal"
          type="button"
        >
          <span className="truncate">{displayValue}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-2 space-y-2"
        align="start"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Input
          ref={inputRef}
          placeholder="Search parent epics..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleKeyDown}
          className="h-8 text-sm"
          aria-label="Search parent epics"
        />
        <ScrollArea className="max-h-48">
          <div role="listbox">
            <button
              type="button"
              role="option"
              aria-selected={false}
              className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent transition-colors text-muted-foreground"
              onClick={handleClear}
            >
              No parent (none)
            </button>
            {isSearching && debouncedSearch && (
              <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Searching...
              </div>
            )}
            {isSearchError && debouncedSearch && (
              <div className="px-2 py-3 text-center text-sm text-destructive" role="alert">
                Search failed. Please try again.
              </div>
            )}
            {!isSearching && !isSearchError && debouncedSearch && results.length === 0 && (
              <div className="px-2 py-3 text-center text-sm text-muted-foreground">
                No results found
              </div>
            )}
            {results.map((epic, index) => (
              <button
                key={epic.id}
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                className={`w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent transition-colors cursor-pointer ${index === selectedIndex && debouncedSearch ? 'bg-accent' : ''}`}
                onClick={() => handleSelect(epic)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="truncate">{epic.title}</span>
                <span className="ml-2 font-mono text-xs text-muted-foreground">
                  {epic.id.slice(0, 8)}
                </span>
              </button>
            ))}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

// --- Main Component ---

export function ScheduleEditorDialog({
  open,
  onOpenChange,
  schedule,
  projectId,
}: ScheduleEditorDialogProps) {
  const isEdit = !!schedule;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormData>(getDefaultFormData());
  const [errors, setErrors] = useState<FormErrors>({});
  const titleInputRef = useRef<HTMLInputElement>(null);
  const descInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setForm(schedule ? scheduleToFormData(schedule) : getDefaultFormData());
      setErrors({});
    }
  }, [open, schedule]);

  // --- Statuses query ---
  const {
    data: statusesData,
    isLoading: statusesLoading,
    isError: statusesError,
  } = useQuery({
    queryKey: ['schedule-statuses', projectId],
    queryFn: () => fetchStatuses(projectId),
    enabled: open && !!projectId,
    staleTime: 5 * 60 * 1000,
  });

  const statuses: Status[] = statusesData?.items ?? [];

  // --- Agents query (isolated key, no guests) ---
  const {
    data: agentsData,
    isLoading: agentsLoading,
    isError: agentsError,
  } = useQuery({
    queryKey: ['schedule-agents', projectId],
    queryFn: () => fetchAgents(projectId),
    enabled: open && !!projectId,
    staleTime: 5 * 60 * 1000,
    select: (data) => ({
      items: data.items.filter(
        (a: Agent & { type?: string }) => a.profileId != null && a.type !== 'guest',
      ),
    }),
  });

  const agents: Agent[] = agentsData?.items ?? [];

  // --- Parent epic resolution for edit mode ---
  const parentIdToResolve =
    isEdit && form.templateParentEpicId && isUuidShaped(form.templateParentEpicId)
      ? form.templateParentEpicId
      : null;

  const {
    data: resolvedParent,
    isLoading: isResolvingParent,
    isError: parentResolveError,
  } = useQuery({
    queryKey: ['schedule-resolve-parent', parentIdToResolve],
    queryFn: async () => {
      const res = await fetch(`/api/epics/${parentIdToResolve}`);
      if (!res.ok) return null;
      const epic: Epic = await res.json();
      if (epic.projectId !== projectId) return null;
      if (epic.parentId != null) return null;
      return { id: epic.id, title: epic.title };
    },
    enabled: open && !!parentIdToResolve,
    staleTime: 5 * 60 * 1000,
  });

  // --- Determine display state for status/agent in edit mode ---
  const currentStatusId = form.templateStatusId;
  const currentStatusResolved = statuses.find((s) => s.id === currentStatusId);
  const statusUnresolved =
    isEdit && currentStatusId && !currentStatusResolved && isUuidShaped(currentStatusId);

  const currentAgentId = form.templateAgentId;
  const currentAgentResolved = agents.find((a) => a.id === currentAgentId);
  const agentUnresolved =
    isEdit && currentAgentId && !currentAgentResolved && isUuidShaped(currentAgentId);

  // --- Mutations ---
  const createMutation = useMutation({
    mutationFn: (data: CreateScheduledEpicData) => createScheduledEpic(data),
    onSuccess: () => {
      toast({ title: 'Schedule created' });
      queryClient.invalidateQueries({ queryKey: ['scheduled-epics', projectId] });
      onOpenChange(false);
    },
    onError: (err) => {
      toast({
        title: 'Error',
        description: err instanceof Error ? err.message : 'Failed to create schedule',
        variant: 'destructive',
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateScheduledEpicData }) =>
      updateScheduledEpic(id, data),
    onSuccess: () => {
      toast({ title: 'Schedule updated' });
      queryClient.invalidateQueries({ queryKey: ['scheduled-epics', projectId] });
      onOpenChange(false);
    },
    onError: (err) => {
      if (err instanceof ScheduledEpicApiError && err.isVersionConflict) {
        toast({
          title: 'Version conflict',
          description: 'This schedule was modified by another user. Please close and try again.',
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Error',
          description: err instanceof Error ? err.message : 'Failed to update schedule',
          variant: 'destructive',
        });
      }
    },
  });

  function validate(): FormErrors {
    const errs: FormErrors = {};
    if (!form.name.trim()) errs.name = 'Name is required';
    if (form.name.length > 200) errs.name = 'Name must be 200 characters or less';
    if (!form.cronExpression.trim()) errs.cronExpression = 'Cron expression is required';
    if (!form.timezone.trim()) errs.timezone = 'Timezone is required';
    if (!form.titleTemplate.trim()) errs.titleTemplate = 'Title template is required';
    return errs;
  }

  function resolvePayloadId(formValue: string, nullSentinel: string): string | null {
    if (!formValue || formValue === nullSentinel) return null;
    return formValue;
  }

  function handleSubmit() {
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const tags = form.templateTags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const templateStatusId = resolvePayloadId(form.templateStatusId, STATUS_NULL_SENTINEL);
    const templateAgentId = resolvePayloadId(form.templateAgentId, AGENT_NULL_SENTINEL);
    const templateParentEpicId = resolvePayloadId(form.templateParentEpicId, PARENT_NULL_SENTINEL);

    if (isEdit && schedule) {
      const data: UpdateScheduledEpicData = {
        configVersion: schedule.configVersion,
        name: form.name,
        cronExpression: form.cronExpression,
        timezone: form.timezone,
        enabled: form.enabled,
        titleTemplate: form.titleTemplate,
        descriptionTemplate: form.descriptionTemplate || null,
        templateStatusId,
        templateParentEpicId,
        templateAgentId,
        templateTags: tags,
        allowOverlap: form.allowOverlap,
        missedRunPolicy: form.missedRunPolicy,
      };
      updateMutation.mutate({ id: schedule.id, data });
    } else {
      const data: CreateScheduledEpicData = {
        projectId,
        name: form.name,
        cronExpression: form.cronExpression,
        timezone: form.timezone,
        enabled: form.enabled,
        titleTemplate: form.titleTemplate,
        descriptionTemplate: form.descriptionTemplate || null,
        templateStatusId,
        templateParentEpicId,
        templateAgentId,
        templateTags: tags,
        allowOverlap: form.allowOverlap,
        missedRunPolicy: form.missedRunPolicy,
      };
      createMutation.mutate(data);
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending;

  // --- Status select value logic ---
  const statusSelectValue = !form.templateStatusId ? STATUS_NULL_SENTINEL : form.templateStatusId;

  const handleStatusChange = (v: string) => {
    setForm({ ...form, templateStatusId: v === STATUS_NULL_SENTINEL ? '' : v });
  };

  // --- Agent select value logic ---
  const agentSelectValue = !form.templateAgentId ? AGENT_NULL_SENTINEL : form.templateAgentId;

  const handleAgentChange = (v: string) => {
    setForm({ ...form, templateAgentId: v === AGENT_NULL_SENTINEL ? '' : v });
  };

  // --- Parent epic value logic ---
  const handleParentChange = (id: string) => {
    if (id === PARENT_NULL_SENTINEL) {
      setForm({ ...form, templateParentEpicId: '' });
    } else {
      setForm({ ...form, templateParentEpicId: id });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Schedule' : 'Create Schedule'}</DialogTitle>
          <DialogDescription className="sr-only">
            {isEdit ? 'Edit a recurring epic schedule.' : 'Create a recurring epic schedule.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {/* Name */}
          <div className="grid gap-1.5">
            <Label htmlFor="schedule-name">Name</Label>
            <Input
              id="schedule-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Daily Standup"
            />
            {errors.name && <p className="text-sm text-destructive">{errors.name}</p>}
          </div>

          {/* Enabled toggle */}
          <div className="flex items-center gap-2">
            <Switch
              id="schedule-enabled"
              checked={form.enabled}
              onCheckedChange={(checked) => setForm({ ...form, enabled: checked })}
            />
            <Label htmlFor="schedule-enabled">Enabled</Label>
          </div>

          {/* Cron schedule */}
          <div className="grid gap-1.5">
            <Label>Schedule</Label>
            <div className="flex gap-2 mb-1">
              <Button
                variant={form.cronMode === 'preset' ? 'default' : 'outline'}
                size="sm"
                type="button"
                onClick={() => setForm({ ...form, cronMode: 'preset' })}
              >
                Preset
              </Button>
              <Button
                variant={form.cronMode === 'custom' ? 'default' : 'outline'}
                size="sm"
                type="button"
                onClick={() => setForm({ ...form, cronMode: 'custom' })}
              >
                Custom
              </Button>
            </div>
            {form.cronMode === 'preset' ? (
              <Select
                value={form.cronExpression}
                onValueChange={(v) => setForm({ ...form, cronExpression: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a schedule" />
                </SelectTrigger>
                <SelectContent>
                  {CRON_PRESETS.map((p) => (
                    <SelectItem key={p.expression} value={p.expression}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={form.cronExpression}
                onChange={(e) => setForm({ ...form, cronExpression: e.target.value })}
                placeholder="e.g. 0 9 * * 1-5"
              />
            )}
            {errors.cronExpression && (
              <p className="text-sm text-destructive">{errors.cronExpression}</p>
            )}
          </div>

          {/* Timezone */}
          <div className="grid gap-1.5">
            <Label htmlFor="schedule-timezone">Timezone</Label>
            <TimezoneSelector
              value={form.timezone}
              onChange={(tz) => setForm({ ...form, timezone: tz })}
              variant="field"
              aria-label="Select timezone"
            />
            {errors.timezone && <p className="text-sm text-destructive">{errors.timezone}</p>}
          </div>

          {/* Title Template with Insert Variable */}
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="schedule-title-template">Title Template</Label>
              <InsertVariableControl
                inputRef={titleInputRef}
                value={form.titleTemplate}
                onChange={(v) => setForm({ ...form, titleTemplate: v })}
              />
            </div>
            <Input
              ref={titleInputRef}
              id="schedule-title-template"
              value={form.titleTemplate}
              onChange={(e) => setForm({ ...form, titleTemplate: e.target.value })}
              placeholder="e.g. Sprint Review {{date}}"
            />
            {errors.titleTemplate && (
              <p className="text-sm text-destructive">{errors.titleTemplate}</p>
            )}
          </div>

          {/* Description Template with Insert Variable */}
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="schedule-desc-template">Description Template (optional)</Label>
              <InsertVariableControl
                inputRef={descInputRef}
                value={form.descriptionTemplate}
                onChange={(v) => setForm({ ...form, descriptionTemplate: v })}
              />
            </div>
            <Textarea
              ref={descInputRef}
              id="schedule-desc-template"
              value={form.descriptionTemplate}
              onChange={(e) => setForm({ ...form, descriptionTemplate: e.target.value })}
              placeholder="Optional Handlebars template for the epic description"
              rows={3}
            />
          </div>

          {/* Status Select */}
          <div className="grid gap-1.5">
            <Label htmlFor="schedule-status">Default Status (optional)</Label>
            {statusesLoading ? (
              <div className="flex items-center gap-2 h-9 px-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading statuses...
              </div>
            ) : (
              <Select value={statusSelectValue} onValueChange={handleStatusChange}>
                <SelectTrigger id="schedule-status">
                  <SelectValue placeholder="Project default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={STATUS_NULL_SENTINEL}>Project default</SelectItem>
                  {statusUnresolved && (
                    <SelectItem value={currentStatusId}>
                      <span className="text-muted-foreground">
                        Unavailable: {currentStatusId.slice(0, 8)}
                      </span>
                    </SelectItem>
                  )}
                  {statuses.map((status) => (
                    <SelectItem key={status.id} value={status.id}>
                      <div className="flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: status.color }}
                        />
                        <span>{status.label}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {statusesError && (
              <p className="text-xs text-destructive" role="alert">
                Failed to load statuses. Existing selection is preserved.
              </p>
            )}
          </div>

          {/* Agent Select */}
          <div className="grid gap-1.5">
            <Label htmlFor="schedule-agent">Default Agent (optional)</Label>
            {agentsLoading ? (
              <div className="flex items-center gap-2 h-9 px-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading agents...
              </div>
            ) : (
              <Select value={agentSelectValue} onValueChange={handleAgentChange}>
                <SelectTrigger id="schedule-agent">
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AGENT_NULL_SENTINEL}>Unassigned</SelectItem>
                  {agentUnresolved && (
                    <SelectItem value={currentAgentId}>
                      <span className="text-muted-foreground">
                        Unavailable: {currentAgentId.slice(0, 8)}
                      </span>
                    </SelectItem>
                  )}
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {agentsError && (
              <p className="text-xs text-destructive" role="alert">
                Failed to load agents. Existing selection is preserved.
              </p>
            )}
          </div>

          {/* Parent Epic Picker */}
          <div className="grid gap-1.5">
            <Label>Parent Epic (optional)</Label>
            <ParentEpicPicker
              projectId={projectId}
              value={form.templateParentEpicId || PARENT_NULL_SENTINEL}
              onChange={handleParentChange}
              resolvedEpic={resolvedParent ?? null}
              isResolving={isResolvingParent}
            />
            {parentResolveError && (
              <p className="text-xs text-destructive" role="alert">
                Failed to resolve parent epic. Existing selection is preserved.
              </p>
            )}
          </div>

          {/* Tags */}
          <div className="grid gap-1.5">
            <Label htmlFor="schedule-tags">Tags (comma-separated, optional)</Label>
            <Input
              id="schedule-tags"
              value={form.templateTags}
              onChange={(e) => setForm({ ...form, templateTags: e.target.value })}
              placeholder="e.g. standup, recurring"
            />
          </div>

          {/* Missed Run Policy */}
          <div className="grid gap-1.5">
            <Label htmlFor="schedule-missed-policy">Missed Run Policy</Label>
            <Select
              value={form.missedRunPolicy}
              onValueChange={(v) =>
                setForm({ ...form, missedRunPolicy: v as ScheduledEpicMissedRunPolicy })
              }
            >
              <SelectTrigger id="schedule-missed-policy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="skip">Skip missed runs</SelectItem>
                <SelectItem value="run_once">Catch up once (latest only)</SelectItem>
                <SelectItem value="run_all">Catch up all (capped)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Allow Overlap */}
          <div className="flex items-center gap-2">
            <Switch
              id="schedule-overlap"
              checked={form.allowOverlap}
              onCheckedChange={(checked) => setForm({ ...form, allowOverlap: checked })}
            />
            <Label htmlFor="schedule-overlap">Allow overlapping runs</Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isPending}>
            {isPending ? 'Saving...' : isEdit ? 'Update' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
