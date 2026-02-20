import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  CheckCircle2,
  FileWarning,
  FolderOpen,
  GitBranch,
  GitMerge,
  Loader2,
  Play,
  Plus,
  RefreshCcw,
  Square,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Checkbox } from '@/ui/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Separator } from '@/ui/components/ui/separator';
import { Textarea } from '@/ui/components/ui/textarea';
import { fetchRuntimeInfo } from '@/ui/lib/runtime';
import { cn } from '@/ui/lib/utils';
import {
  createWorktree,
  deleteWorktree,
  fetchTemplate,
  listBranches,
  listWorktreeActivity,
  listTemplates,
  listWorktreeOverviews,
  listWorktrees,
  previewMerge,
  stopWorktree,
  triggerMerge,
  type CreateWorktreeInput,
  type TemplateListItem,
  type WorktreeApiError,
  type WorktreeActivityEvent,
  type WorktreeMergeConflict,
  type WorktreeMergePreview,
  type WorktreeSummary,
} from './lib/worktrees';

type TabVisual = {
  icon: string;
  label: string;
  iconClassName: string;
};

const REFRESH_INTERVAL_MS = 15_000;
const ACTIVITY_REFRESH_INTERVAL_MS = 60_000;
const OVERVIEW_TAB_ID = 'overview';
const WORKTREE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const INVALID_BRANCH_CONTROL_OR_SPACE = /[\x00-\x20\x7f]/;
const INVALID_BRANCH_CHARS = /[~^:?*\[]/;

function formatMaybeCount(value: number | null): string {
  if (value === null || value === undefined) {
    return '--';
  }
  return String(value);
}

function getDerivedStatus(worktree: WorktreeSummary, mergeInProgress = false): TabVisual {
  if (mergeInProgress) {
    return { icon: '◔', label: 'Merging', iconClassName: 'text-amber-600' };
  }

  const normalized = worktree.status.toLowerCase();

  if (normalized === 'merged') {
    return { icon: '🔀', label: 'Merged', iconClassName: 'text-violet-600' };
  }
  if (normalized === 'completed') {
    return { icon: '✓', label: 'Completed', iconClassName: 'text-emerald-600' };
  }
  if (normalized === 'stopped') {
    return { icon: '■', label: 'Stopped', iconClassName: 'text-slate-500' };
  }
  if (normalized === 'error') {
    return { icon: '✕', label: 'Error', iconClassName: 'text-red-600' };
  }
  if (normalized === 'running') {
    const isIdle =
      (worktree.commitsAhead ?? 0) === 0 &&
      (worktree.commitsBehind ?? 0) === 0 &&
      !worktree.errorMessage;
    if (isIdle) {
      return { icon: '◌', label: 'Idle', iconClassName: 'text-amber-600' };
    }
    return { icon: '●', label: 'Running', iconClassName: 'text-blue-600' };
  }

  return { icon: '●', label: 'Creating', iconClassName: 'text-sky-500' };
}

function getRuntimeTypeLabel(
  runtimeType: WorktreeSummary['runtimeType'] | null | undefined,
): string {
  return String(runtimeType).trim().toLowerCase() === 'process' ? 'Process' : 'Container';
}

function getRuntimeTypeBadgeClassName(
  runtimeType: WorktreeSummary['runtimeType'] | null | undefined,
): string {
  return String(runtimeType).trim().toLowerCase() === 'process'
    ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    : 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300';
}

function normalizeWorktreeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 63);
}

function deriveBranchName(worktreeName: string): string {
  return normalizeWorktreeName(worktreeName);
}

function isValidGitBranchName(name: string): boolean {
  if (name.length < 1 || name.length > 255) {
    return false;
  }
  if (INVALID_BRANCH_CONTROL_OR_SPACE.test(name)) {
    return false;
  }
  if (
    name.includes('..') ||
    name.includes('@{') ||
    name.includes('//') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.startsWith('.') ||
    name.endsWith('.') ||
    name.endsWith('.lock')
  ) {
    return false;
  }
  if (INVALID_BRANCH_CHARS.test(name)) {
    return false;
  }
  const segments = name.split('/');
  return !segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..');
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Request failed';
}

function isWorktreeApiError(error: unknown): error is WorktreeApiError {
  return (
    error instanceof Error &&
    'status' in error &&
    typeof (error as { status?: unknown }).status === 'number' &&
    'conflicts' in error &&
    Array.isArray((error as { conflicts?: unknown }).conflicts)
  );
}

function parseStoredMergeConflicts(raw: string | null | undefined): WorktreeMergeConflict[] {
  if (!raw) {
    return [];
  }
  const files = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return [...new Set(files)].map((file) => ({ file, type: 'merge' }));
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatRelativeTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) {
    return 'just now';
  }
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function getActivityIconVisual(type: WorktreeActivityEvent['type']): {
  icon: JSX.Element;
  className: string;
} {
  const normalizedType = String(type).trim().toLowerCase();
  if (normalizedType === 'started') {
    return {
      icon: <Play className="h-4 w-4" />,
      className: 'text-emerald-600',
    };
  }
  if (normalizedType === 'stopped') {
    return {
      icon: <Square className="h-4 w-4" />,
      className: 'text-slate-500',
    };
  }
  if (normalizedType === 'created') {
    return {
      icon: <Plus className="h-4 w-4" />,
      className: 'text-sky-600',
    };
  }
  if (normalizedType === 'deleted') {
    return {
      icon: <Trash2 className="h-4 w-4" />,
      className: 'text-rose-600',
    };
  }
  if (normalizedType === 'merged') {
    return {
      icon: <GitMerge className="h-4 w-4" />,
      className: 'text-violet-600',
    };
  }
  if (normalizedType === 'error') {
    return {
      icon: <AlertCircle className="h-4 w-4" />,
      className: 'text-red-600',
    };
  }
  if (normalizedType === 'rebased') {
    return {
      icon: <GitBranch className="h-4 w-4" />,
      className: 'text-amber-600',
    };
  }

  return {
    icon: <AlertCircle className="h-4 w-4" />,
    className: 'text-muted-foreground',
  };
}

export function CreateWorktreeDialog({
  open,
  onOpenChange,
  templates,
  baseBranchOptions,
  isBranchesLoading,
  branchesError,
  isTemplatesLoading,
  templatesError,
  dockerAvailable,
  isSubmitting,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  templates: TemplateListItem[];
  baseBranchOptions: string[];
  isBranchesLoading: boolean;
  branchesError: string | null;
  isTemplatesLoading: boolean;
  templatesError: string | null;
  dockerAvailable: boolean;
  isSubmitting: boolean;
  onSubmit: (input: Omit<CreateWorktreeInput, 'ownerProjectId'>) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [branchName, setBranchName] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [templateSlug, setTemplateSlug] = useState('');
  const [description, setDescription] = useState('');
  const [useDockerContainer, setUseDockerContainer] = useState(dockerAvailable);
  const [branchIsAutoDerived, setBranchIsAutoDerived] = useState(true);
  const [selectedPreset, setSelectedPreset] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setName('');
    setBranchName('');
    setBaseBranch(baseBranchOptions[0] ?? '');
    setTemplateSlug(templates[0]?.slug ?? '');
    setDescription('');
    setUseDockerContainer(dockerAvailable);
    setBranchIsAutoDerived(true);
    setSelectedPreset('');
    setError(null);
  }, [open, baseBranchOptions, dockerAvailable, templates]);

  useEffect(() => {
    if (!open) {
      return;
    }
    if (!baseBranch.trim() && baseBranchOptions.length > 0) {
      setBaseBranch(baseBranchOptions[0]);
    }
  }, [baseBranchOptions, baseBranch, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    if (templates.length > 0 && !templates.some((template) => template.slug === templateSlug)) {
      setTemplateSlug(templates[0].slug);
    }
  }, [open, templateSlug, templates]);

  // Fetch full template content to extract presets
  const { data: templateDetail } = useQuery({
    queryKey: ['template-detail', templateSlug],
    queryFn: () => fetchTemplate(templateSlug),
    enabled: Boolean(templateSlug),
    staleTime: 5 * 60 * 1000,
  });

  const availablePresets = useMemo(() => {
    const presets = templateDetail?.content?.presets;
    if (!Array.isArray(presets) || presets.length === 0) return [];
    return presets.map((p) => p.name).reverse();
  }, [templateDetail]);

  // Reset preset when template changes
  useEffect(() => {
    setSelectedPreset('');
  }, [templateSlug]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    const resolvedName = normalizeWorktreeName(name);
    const resolvedBranchName = branchName.trim();
    const resolvedDescription = description.trim();

    if (!WORKTREE_NAME_PATTERN.test(resolvedName)) {
      setError(
        'Name must use lowercase letters, numbers, and hyphens (1-63 chars, no leading/trailing hyphen).',
      );
      return;
    }
    if (!isValidGitBranchName(resolvedBranchName)) {
      setError('Branch name is invalid.');
      return;
    }
    const resolvedBaseBranch = baseBranch.trim();
    if (!resolvedBaseBranch) {
      setError('Base branch is required.');
      return;
    }
    if (!templateSlug.trim()) {
      setError('Template is required.');
      return;
    }

    try {
      await onSubmit({
        name: resolvedName,
        branchName: resolvedBranchName,
        baseBranch: resolvedBaseBranch,
        templateSlug,
        description: resolvedDescription.length > 0 ? resolvedDescription : undefined,
        runtimeType: useDockerContainer && dockerAvailable ? 'container' : 'process',
        ...(selectedPreset && { presetName: selectedPreset }),
      });
    } catch (submitError) {
      setError(toErrorMessage(submitError));
    }
  }

  const canSelectBaseBranch = baseBranchOptions.length > 0;
  const showManualBaseBranchInput =
    Boolean(branchesError) || (!isBranchesLoading && baseBranchOptions.length === 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create New Worktree</DialogTitle>
          <DialogDescription>
            Create an isolated worktree runtime from a selected template.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="wt-name">Name</Label>
              <Input
                id="wt-name"
                value={name}
                placeholder="feature-auth"
                onChange={(event) => {
                  const normalizedName = normalizeWorktreeName(event.target.value);
                  setName(normalizedName);
                  if (branchIsAutoDerived) {
                    setBranchName(deriveBranchName(normalizedName));
                  }
                }}
                disabled={isSubmitting}
              />
              <p className="text-xs text-muted-foreground">
                Used for worktree path and container name.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="wt-branch">Branch Name</Label>
              <Input
                id="wt-branch"
                value={branchName}
                placeholder="feature-auth"
                onChange={(event) => {
                  const nextBranch = event.target.value;
                  setBranchName(nextBranch);
                  setBranchIsAutoDerived(nextBranch === deriveBranchName(name));
                }}
                disabled={isSubmitting}
              />
              <p className="text-xs text-muted-foreground">
                Auto-derived from name until manually edited.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="wt-base">Base Branch</Label>
                <Select
                  value={
                    canSelectBaseBranch && baseBranchOptions.includes(baseBranch) ? baseBranch : ''
                  }
                  onValueChange={setBaseBranch}
                  disabled={isSubmitting || isBranchesLoading || !canSelectBaseBranch}
                >
                  <SelectTrigger id="wt-base">
                    <SelectValue
                      placeholder={isBranchesLoading ? 'Loading branches...' : 'Select base branch'}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {baseBranchOptions.map((branch) => (
                      <SelectItem key={branch} value={branch}>
                        {branch}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {isBranchesLoading && (
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Loading branches...
                  </p>
                )}
                {branchesError && (
                  <p className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700">
                    {branchesError}
                  </p>
                )}
                {showManualBaseBranchInput && (
                  <>
                    <Label htmlFor="wt-base-manual" className="text-xs text-muted-foreground">
                      Enter base branch manually
                    </Label>
                    <Input
                      id="wt-base-manual"
                      value={baseBranch}
                      placeholder="main"
                      onChange={(event) => setBaseBranch(event.target.value)}
                      disabled={isSubmitting}
                    />
                  </>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="wt-template">Template</Label>
                <Select
                  value={templateSlug}
                  onValueChange={setTemplateSlug}
                  disabled={isSubmitting || isTemplatesLoading || templates.length === 0}
                >
                  <SelectTrigger id="wt-template">
                    <SelectValue
                      placeholder={isTemplatesLoading ? 'Loading templates...' : 'Select template'}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((template) => (
                      <SelectItem key={template.slug} value={template.slug}>
                        {template.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {isTemplatesLoading && (
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Loading templates...
                  </p>
                )}
                {templatesError && (
                  <p className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700">
                    {templatesError}
                  </p>
                )}
              </div>
            </div>
            {availablePresets.length > 0 && (
              <div className="grid gap-2">
                <Label htmlFor="wt-preset">Preset (Optional)</Label>
                <Select
                  value={selectedPreset || '__none__'}
                  onValueChange={(v) => setSelectedPreset(v === '__none__' ? '' : v)}
                  disabled={isSubmitting}
                >
                  <SelectTrigger id="wt-preset">
                    <SelectValue placeholder="Use default configuration" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Default configuration</SelectItem>
                    {availablePresets.map((presetName) => (
                      <SelectItem key={presetName} value={presetName}>
                        {presetName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Optionally select a preset to pre-configure agent providers
                </p>
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="wt-description">Description</Label>
              <Textarea
                id="wt-description"
                value={description}
                placeholder="Describe the worktree goal and implementation scope..."
                rows={4}
                onChange={(event) => setDescription(event.target.value)}
                disabled={isSubmitting}
              />
            </div>
            <div className="grid gap-2 rounded-md border p-3">
              <div className="flex items-start gap-2">
                <Checkbox
                  id="wt-use-docker"
                  checked={useDockerContainer}
                  onCheckedChange={(value) => setUseDockerContainer(value === true)}
                  disabled={isSubmitting || !dockerAvailable}
                />
                <div className="grid gap-1">
                  <Label
                    htmlFor="wt-use-docker"
                    className={cn(!dockerAvailable && 'text-muted-foreground')}
                  >
                    Use Docker container
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Provides full process and filesystem isolation.
                  </p>
                </div>
              </div>
              {!dockerAvailable && (
                <p className="text-xs text-muted-foreground">
                  Docker is required for container isolation. Worktree will run as a host process.
                </p>
              )}
            </div>
            {error && (
              <p className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-700">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MergePreviewDialog({
  open,
  onOpenChange,
  worktree,
  preview,
  isPreviewLoading,
  previewError,
  isMerging,
  onConfirmMerge,
  onResolveManually,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  worktree: WorktreeSummary | null;
  preview: WorktreeMergePreview | null;
  isPreviewLoading: boolean;
  previewError: string | null;
  isMerging: boolean;
  onConfirmMerge: (worktreeId: string) => Promise<void>;
  onResolveManually: (worktree: WorktreeSummary) => Promise<void>;
}) {
  const conflicts = preview?.conflicts ?? [];
  const canMerge = Boolean(preview?.canMerge);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Merge Preview</DialogTitle>
          <DialogDescription>
            {worktree
              ? `Review merge changes for "${worktree.name}" before executing merge.`
              : 'Review merge changes before executing merge.'}
          </DialogDescription>
        </DialogHeader>

        {isPreviewLoading ? (
          <div className="flex items-center gap-2 rounded-md border p-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading merge preview...
          </div>
        ) : previewError ? (
          <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700">
            {previewError}
          </div>
        ) : preview ? (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-3">
              <InfoCell label="Ahead" value={String(preview.commitsAhead)} />
              <InfoCell label="Behind" value={String(preview.commitsBehind)} />
              <InfoCell label="Files Changed" value={String(preview.filesChanged)} />
              <InfoCell label="Insertions" value={String(preview.insertions)} />
              <InfoCell label="Deletions" value={String(preview.deletions)} />
              <InfoCell label="Conflicts" value={String(conflicts.length)} />
            </div>

            {conflicts.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
                <p className="text-sm font-medium text-amber-800">Conflicting files</p>
                <ul className="mt-2 space-y-1 text-sm text-amber-900">
                  {conflicts.map((conflict) => (
                    <li
                      key={`${conflict.type}:${conflict.file}`}
                      className="flex items-center gap-2"
                    >
                      <FileWarning className="h-4 w-4 shrink-0" />
                      <span className="font-mono text-xs">{conflict.file}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-amber-700">
                  Resolve conflicts manually or abort this merge attempt.
                </p>
              </div>
            )}

            {preview.canMerge && (
              <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800">
                Merge can proceed cleanly.
              </div>
            )}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isMerging}>
            Abort
          </Button>
          {worktree && preview && !canMerge && (
            <Button
              variant="secondary"
              onClick={() => void onResolveManually(worktree)}
              disabled={isMerging}
            >
              <FolderOpen className="mr-2 h-4 w-4" />
              Resolve Manually
            </Button>
          )}
          {worktree && preview && canMerge && (
            <Button
              variant="default"
              onClick={() => void onConfirmMerge(worktree.id)}
              disabled={isMerging}
            >
              {isMerging && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm Merge
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteWorktreeDialog({
  open,
  onOpenChange,
  worktree,
  deleteBranch,
  onDeleteBranchChange,
  isDeleting,
  onConfirmDelete,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  worktree: WorktreeSummary | null;
  deleteBranch: boolean;
  onDeleteBranchChange: (value: boolean) => void;
  isDeleting: boolean;
  onConfirmDelete: () => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Worktree</DialogTitle>
          <DialogDescription>
            {worktree
              ? `Delete worktree "${worktree.name}"? This action cannot be undone.`
              : 'Delete this worktree? This action cannot be undone.'}
          </DialogDescription>
        </DialogHeader>
        {worktree && (
          <div className="flex items-center gap-3 rounded-md border p-3">
            <Checkbox
              id="delete-branch-checkbox"
              checked={deleteBranch}
              onCheckedChange={(checked) => onDeleteBranchChange(checked === true)}
            />
            <Label htmlFor="delete-branch-checkbox" className="text-sm font-normal">
              Also delete git branch <span className="font-mono">{worktree.branchName}</span>
            </Label>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isDeleting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              void onConfirmDelete();
            }}
            disabled={isDeleting || !worktree}
          >
            {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Delete Worktree
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function OrchestratorApp({ ownerProjectId }: { ownerProjectId?: string | null } = {}) {
  const queryClient = useQueryClient();
  const scopedWorktreesQueryKey = ['orchestrator-worktrees', ownerProjectId ?? null] as const;
  const scopedActivityQueryKey = [
    'orchestrator-worktree-activity',
    ownerProjectId ?? null,
  ] as const;
  const [activeTabId, setActiveTabId] = useState<string>(OVERVIEW_TAB_ID);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);
  const [mergeDialogWorktreeId, setMergeDialogWorktreeId] = useState<string | null>(null);
  const [deleteDialogWorktreeId, setDeleteDialogWorktreeId] = useState<string | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [deletingWorktreeIds, setDeletingWorktreeIds] = useState<Record<string, boolean>>({});
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string | undefined>>({});
  const [mergeInProgressWorktreeId, setMergeInProgressWorktreeId] = useState<string | null>(null);
  const [dismissedMergedNoticeIds, setDismissedMergedNoticeIds] = useState<string[]>([]);
  const [mergeConflictMap, setMergeConflictMap] = useState<Record<string, WorktreeMergeConflict[]>>(
    {},
  );

  const worktreesQuery = useQuery({
    queryKey: scopedWorktreesQueryKey,
    queryFn: () =>
      ownerProjectId
        ? listWorktrees({
            ownerProjectId,
          })
        : listWorktrees(),
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });

  const overviewQuery = useQuery({
    queryKey: ['orchestrator-worktree-overview', ownerProjectId ?? null],
    queryFn: () =>
      ownerProjectId
        ? listWorktreeOverviews({
            ownerProjectId,
          })
        : listWorktreeOverviews(),
    enabled: activeTabId === OVERVIEW_TAB_ID,
    refetchInterval: activeTabId === OVERVIEW_TAB_ID ? REFRESH_INTERVAL_MS : false,
    refetchOnWindowFocus: true,
  });

  const activityQuery = useQuery({
    queryKey: scopedActivityQueryKey,
    queryFn: () =>
      ownerProjectId
        ? listWorktreeActivity({
            ownerProjectId,
          })
        : listWorktreeActivity(),
    enabled: activeTabId === OVERVIEW_TAB_ID,
    refetchInterval: activeTabId === OVERVIEW_TAB_ID ? ACTIVITY_REFRESH_INTERVAL_MS : false,
    refetchOnWindowFocus: true,
  });

  const templatesQuery = useQuery({
    queryKey: ['orchestrator-worktree-templates'],
    queryFn: listTemplates,
    enabled: createDialogOpen,
    staleTime: 60_000,
  });

  const branchesQuery = useQuery({
    queryKey: ['orchestrator-branches'],
    queryFn: listBranches,
    enabled: createDialogOpen,
    staleTime: 30_000,
  });

  const runtimeQuery = useQuery({
    queryKey: ['orchestrator-runtime-info'],
    queryFn: fetchRuntimeInfo,
    staleTime: 60_000,
  });

  const createWorktreeMutation = useMutation({
    mutationFn: createWorktree,
    onSuccess: (createdWorktree) => {
      setCreateDialogOpen(false);
      setActiveTabId(createdWorktree.id);
      setActionError(null);
      queryClient.setQueryData<WorktreeSummary[]>(scopedWorktreesQueryKey, (existing) => {
        const items = existing ?? [];
        const withoutCreated = items.filter((item) => item.id !== createdWorktree.id);
        return [createdWorktree, ...withoutCreated];
      });
      void queryClient.invalidateQueries({ queryKey: ['orchestrator-worktrees'] });
      void queryClient.invalidateQueries({ queryKey: ['orchestrator-worktree-overview'] });
      void queryClient.invalidateQueries({ queryKey: ['orchestrator-worktree-activity'] });
    },
  });

  const stopWorktreeMutation = useMutation({
    mutationFn: stopWorktree,
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['orchestrator-worktrees'] });
      void queryClient.invalidateQueries({ queryKey: ['orchestrator-worktree-overview'] });
      void queryClient.invalidateQueries({ queryKey: ['orchestrator-worktree-activity'] });
    },
  });

  const deleteWorktreeMutation = useMutation({
    mutationFn: ({ id, deleteBranch: shouldDeleteBranch }: { id: string; deleteBranch: boolean }) =>
      deleteWorktree(id, { deleteBranch: shouldDeleteBranch }),
    onSuccess: (_, variables) => {
      if (activeTabId === variables.id) {
        setActiveTabId(OVERVIEW_TAB_ID);
      }
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['orchestrator-worktrees'] });
      void queryClient.invalidateQueries({ queryKey: ['orchestrator-worktree-overview'] });
      void queryClient.invalidateQueries({ queryKey: ['orchestrator-worktree-activity'] });
    },
  });

  const mergeWorktreeMutation = useMutation({
    mutationFn: triggerMerge,
    onMutate: async (worktreeId) => {
      setMergeInProgressWorktreeId(worktreeId);
      setActionError(null);
      setActionInfo(null);
    },
    onSuccess: (mergedWorktree) => {
      setMergeDialogWorktreeId(null);
      setMergeConflictMap((current) => {
        if (!current[mergedWorktree.id]) {
          return current;
        }
        const next = { ...current };
        delete next[mergedWorktree.id];
        return next;
      });
      setDismissedMergedNoticeIds((current) => current.filter((id) => id !== mergedWorktree.id));
      setActionError(null);
      setActionInfo(`Merged "${mergedWorktree.name}". Keep or delete the worktree from its tab.`);
      void queryClient.invalidateQueries({ queryKey: ['orchestrator-worktrees'] });
      void queryClient.invalidateQueries({ queryKey: ['orchestrator-worktree-overview'] });
      void queryClient.invalidateQueries({ queryKey: ['orchestrator-worktree-activity'] });
    },
    onError: (error, worktreeId) => {
      if (isWorktreeApiError(error) && error.conflicts.length > 0) {
        setMergeConflictMap((current) => ({ ...current, [worktreeId]: error.conflicts }));
      }
      setActionError(toErrorMessage(error));
    },
    onSettled: (_data, _error, worktreeId) => {
      setMergeInProgressWorktreeId((current) => (current === worktreeId ? null : current));
    },
  });

  const worktrees = worktreesQuery.data ?? [];
  const overviewRows = overviewQuery.data ?? [];
  const activityItems = activityQuery.data ?? [];
  const templates = templatesQuery.data ?? [];

  const selectedWorktree = useMemo(
    () =>
      activeTabId === OVERVIEW_TAB_ID
        ? null
        : (worktrees.find((worktree) => worktree.id === activeTabId) ?? null),
    [activeTabId, worktrees],
  );

  const selectedConflictFiles = useMemo(() => {
    if (!selectedWorktree) {
      return [] as WorktreeMergeConflict[];
    }
    const fromApiError = mergeConflictMap[selectedWorktree.id];
    if (fromApiError && fromApiError.length > 0) {
      return fromApiError;
    }
    return parseStoredMergeConflicts(selectedWorktree.mergeConflicts);
  }, [mergeConflictMap, selectedWorktree]);

  const mergeDialogWorktree = useMemo(
    () =>
      mergeDialogWorktreeId
        ? (worktrees.find((worktree) => worktree.id === mergeDialogWorktreeId) ?? null)
        : null,
    [mergeDialogWorktreeId, worktrees],
  );
  const deleteDialogWorktree = useMemo(
    () =>
      deleteDialogWorktreeId
        ? (worktrees.find((worktree) => worktree.id === deleteDialogWorktreeId) ?? null)
        : null,
    [deleteDialogWorktreeId, worktrees],
  );

  const mergePreviewQuery = useQuery({
    queryKey: ['orchestrator-worktree-merge-preview', mergeDialogWorktreeId],
    queryFn: async () => {
      if (!mergeDialogWorktreeId) {
        throw new Error('No worktree selected for merge preview');
      }
      return previewMerge(mergeDialogWorktreeId);
    },
    enabled: Boolean(mergeDialogWorktreeId),
    retry: false,
  });

  useEffect(() => {
    const worktreeId = mergeDialogWorktreeId;
    const preview = mergePreviewQuery.data;
    if (!worktreeId || !preview || preview.conflicts.length > 0) {
      return;
    }

    setMergeConflictMap((current) => {
      if (!current[worktreeId]) {
        return current;
      }
      const next = { ...current };
      delete next[worktreeId];
      return next;
    });

    queryClient.setQueryData<WorktreeSummary[]>(scopedWorktreesQueryKey, (existing) => {
      if (!existing) {
        return existing;
      }
      return existing.map((item) =>
        item.id === worktreeId
          ? {
              ...item,
              mergeConflicts: null,
            }
          : item,
      );
    });
  }, [mergeDialogWorktreeId, mergePreviewQuery.data, queryClient, scopedWorktreesQueryKey]);

  useEffect(() => {
    if (worktrees.length === 0) {
      setActiveTabId(OVERVIEW_TAB_ID);
      return;
    }

    if (
      activeTabId !== OVERVIEW_TAB_ID &&
      !worktrees.some((worktree) => worktree.id === activeTabId)
    ) {
      setActiveTabId(worktrees[0].id);
    }
  }, [activeTabId, worktrees]);

  const baseBranchOptions = branchesQuery.data ?? [];

  async function handleCreateWorktree(
    input: Omit<CreateWorktreeInput, 'ownerProjectId'>,
  ): Promise<void> {
    const resolvedOwnerProjectId = ownerProjectId?.trim();
    if (!resolvedOwnerProjectId) {
      throw new Error('Select a project before creating a worktree.');
    }

    await createWorktreeMutation.mutateAsync({
      ...input,
      ownerProjectId: resolvedOwnerProjectId,
    });
  }

  async function handleStopWorktree(id: string): Promise<void> {
    try {
      await stopWorktreeMutation.mutateAsync(id);
      setActionInfo(null);
    } catch (error) {
      setActionError(toErrorMessage(error));
    }
  }

  function handleOpenDeleteWorktreeDialog(worktree: WorktreeSummary): void {
    setDeleteDialogWorktreeId(worktree.id);
    setDeleteBranch(true);
    if (deleteErrors[worktree.id]) {
      setDeleteErrors((current) => {
        const next = { ...current };
        delete next[worktree.id];
        return next;
      });
    }
    setActionError(null);
    setActionInfo(null);
  }

  async function handleDeleteWorktree(): Promise<void> {
    if (!deleteDialogWorktree) {
      return;
    }

    const worktreeId = deleteDialogWorktree.id;
    const shouldDeleteBranch = deleteBranch;
    setDeleteDialogWorktreeId(null);
    setDeleteBranch(true);
    setActionInfo(null);

    setDeletingWorktreeIds((current) => ({ ...current, [worktreeId]: true }));
    if (deleteErrors[worktreeId]) {
      setDeleteErrors((current) => {
        const next = { ...current };
        delete next[worktreeId];
        return next;
      });
    }

    deleteWorktreeMutation.mutate(
      {
        id: worktreeId,
        deleteBranch: shouldDeleteBranch,
      },
      {
        onError: (error) => {
          setDeleteErrors((current) => ({
            ...current,
            [worktreeId]: toErrorMessage(error),
          }));
        },
        onSettled: () => {
          setDeletingWorktreeIds((current) => {
            if (!current[worktreeId]) {
              return current;
            }
            const next = { ...current };
            delete next[worktreeId];
            return next;
          });
        },
      },
    );
  }

  function handleOpenMergePreview(worktree: WorktreeSummary): void {
    setMergeDialogWorktreeId(worktree.id);
    setActionError(null);
    setActionInfo(null);
  }

  async function handleMergeWorktree(id: string): Promise<void> {
    try {
      await mergeWorktreeMutation.mutateAsync(id);
    } catch (error) {
      setActionError(toErrorMessage(error));
    }
  }

  async function handleResolveManually(worktree: WorktreeSummary): Promise<void> {
    if (!worktree.worktreePath) {
      setActionError('Cannot resolve manually: worktree path is unavailable.');
      return;
    }

    const worktreePath = worktree.worktreePath;
    const editorUri = `vscode://file/${encodeURI(worktreePath)}`;
    let openedEditor = false;

    try {
      openedEditor = Boolean(window.open(editorUri, '_blank', 'noopener,noreferrer'));
    } catch {
      openedEditor = false;
    }

    let copied = false;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(worktreePath);
        copied = true;
      } catch {
        copied = false;
      }
    }

    setActionError(null);
    if (openedEditor && copied) {
      setActionInfo('Opened editor and copied worktree path for manual conflict resolution.');
    } else if (openedEditor) {
      setActionInfo('Opened worktree in editor for manual conflict resolution.');
    } else if (copied) {
      setActionInfo('Worktree path copied. Open it in your editor to resolve conflicts.');
    } else {
      setActionInfo(`Open your editor at: ${worktreePath}`);
    }
  }

  async function handleAbortMerge(worktree: WorktreeSummary): Promise<void> {
    if (!worktree.worktreePath) {
      setActionInfo('Merge aborted in UI. Resolve conflicts manually before retrying merge.');
      setActionError(null);
      setMergeDialogWorktreeId(null);
      return;
    }

    const command = `git -C "${worktree.worktreePath}" merge --abort`;
    let copied = false;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(command);
        copied = true;
      } catch {
        copied = false;
      }
    }

    if (copied) {
      setActionInfo('Abort command copied. Run it in terminal to cancel in-progress merge state.');
    } else {
      setActionInfo(`Run this command to abort merge: ${command}`);
    }
    setActionError(null);
    setMergeDialogWorktreeId(null);
  }

  function handleKeepWorktree(id: string): void {
    setDismissedMergedNoticeIds((current) => (current.includes(id) ? current : [...current, id]));
    setActionError(null);
    setActionInfo('Keeping merged worktree.');
  }

  const selectedVisual = selectedWorktree
    ? getDerivedStatus(selectedWorktree, mergeInProgressWorktreeId === selectedWorktree.id)
    : null;
  const selectedWorktreeId = selectedWorktree?.id ?? null;
  const selectedIsDeleting = selectedWorktreeId
    ? Boolean(deletingWorktreeIds[selectedWorktreeId])
    : false;
  const selectedDeleteError = selectedWorktreeId ? deleteErrors[selectedWorktreeId] : undefined;
  const selectedIsMerged = String(selectedWorktree?.status ?? '').toLowerCase() === 'merged';
  const showSelectedMergedNotice =
    Boolean(selectedWorktree) &&
    selectedIsMerged &&
    !dismissedMergedNoticeIds.includes(selectedWorktree?.id ?? '');

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4 sm:p-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Orchestrator</p>
            <h1 className="text-2xl font-semibold">Worktree Dashboard</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => worktreesQuery.refetch()}
              disabled={worktreesQuery.isLoading || worktreesQuery.isFetching}
            >
              <RefreshCcw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New Worktree
            </Button>
          </div>
        </header>

        <Card>
          <CardContent className="p-3">
            <div className="flex gap-2 overflow-x-auto pb-1">
              <button
                type="button"
                onClick={() => setActiveTabId(OVERVIEW_TAB_ID)}
                className={cn(
                  'inline-flex min-w-max items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                  activeTabId === OVERVIEW_TAB_ID
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-card hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <span className="text-base leading-none">◫</span>
                <span className="font-medium">Overview</span>
              </button>
              {worktrees.map((worktree) => {
                const visual = getDerivedStatus(
                  worktree,
                  mergeInProgressWorktreeId === worktree.id,
                );
                const selected = activeTabId === worktree.id;
                return (
                  <button
                    key={worktree.id}
                    type="button"
                    onClick={() => setActiveTabId(worktree.id)}
                    className={cn(
                      'inline-flex min-w-max items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                      selected
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-card hover:bg-accent hover:text-accent-foreground',
                    )}
                  >
                    <span className={cn('text-base leading-none', visual.iconClassName)}>
                      {visual.icon}
                    </span>
                    <span className="font-medium">{worktree.name}</span>
                  </button>
                );
              })}

              {worktrees.length === 0 && (
                <p className="px-2 py-2 text-sm text-muted-foreground">
                  No worktrees available yet.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {worktreesQuery.error instanceof Error && (
          <Card className="border-red-300 bg-red-50/60 dark:bg-red-950/20">
            <CardContent className="flex items-start gap-3 p-4">
              <AlertCircle className="mt-0.5 h-4 w-4 text-red-600" />
              <p className="text-sm text-red-700 dark:text-red-300">
                {worktreesQuery.error.message}
              </p>
            </CardContent>
          </Card>
        )}

        {actionError && (
          <Card className="border-red-300 bg-red-50/60 dark:bg-red-950/20">
            <CardContent className="flex items-start gap-3 p-4">
              <AlertCircle className="mt-0.5 h-4 w-4 text-red-600" />
              <p className="text-sm text-red-700 dark:text-red-300">{actionError}</p>
            </CardContent>
          </Card>
        )}

        {actionInfo && (
          <Card className="border-emerald-300 bg-emerald-50/70">
            <CardContent className="flex items-start gap-3 p-4">
              <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-700" />
              <p className="text-sm text-emerald-800">{actionInfo}</p>
            </CardContent>
          </Card>
        )}

        {activeTabId === OVERVIEW_TAB_ID ? (
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <Card>
              <CardHeader className="space-y-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Worktree Overview</CardTitle>
                  {overviewQuery.isFetching && (
                    <p className="text-xs text-muted-foreground">Refreshing overview...</p>
                  )}
                </div>
                <Separator />
              </CardHeader>
              <CardContent>
                {overviewQuery.isLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading overview data...
                  </div>
                ) : overviewQuery.error instanceof Error ? (
                  <p className="text-sm text-red-700 dark:text-red-300">
                    {overviewQuery.error.message}
                  </p>
                ) : overviewRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No worktree overview data available.
                  </p>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    {overviewRows.map((overview) => {
                      const worktree = overview.worktree;
                      const isMergeInProgress = mergeInProgressWorktreeId === worktree.id;
                      const visual = getDerivedStatus(worktree, isMergeInProgress);
                      const normalizedStatus = String(worktree.status).toLowerCase();
                      const isDeleting = Boolean(deletingWorktreeIds[worktree.id]);
                      const deleteError = deleteErrors[worktree.id];
                      const isMerged = normalizedStatus === 'merged';
                      const stopDisabled = ['stopped', 'merged', 'creating'].includes(
                        normalizedStatus,
                      );
                      const mergeDisabled = ['merged', 'creating'].includes(normalizedStatus);

                      return (
                        <div key={worktree.id} className="space-y-2">
                          <Card
                            aria-busy={isDeleting || undefined}
                            className={cn('relative border-border/80', isDeleting && 'opacity-70')}
                          >
                            {isDeleting ? (
                              <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60">
                                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                              </div>
                            ) : null}
                            <CardHeader className="space-y-3">
                              <div className="flex items-start justify-between gap-2">
                                <div>
                                  <CardTitle className="text-base">{worktree.name}</CardTitle>
                                  <p className="text-sm text-muted-foreground">
                                    {worktree.branchName}
                                  </p>
                                </div>
                                <div className="flex flex-wrap items-center justify-end gap-2">
                                  <Badge
                                    variant="outline"
                                    className={cn('font-medium', visual.iconClassName)}
                                  >
                                    {visual.icon} {visual.label}
                                  </Badge>
                                  <Badge
                                    variant="outline"
                                    className={cn(
                                      'font-medium',
                                      getRuntimeTypeBadgeClassName(worktree.runtimeType),
                                    )}
                                  >
                                    {getRuntimeTypeLabel(worktree.runtimeType)}
                                  </Badge>
                                </div>
                              </div>
                              <Separator />
                              <div className="grid grid-cols-2 gap-2">
                                <InfoCell label="Template" value={worktree.templateSlug} />
                                <InfoCell
                                  label="Epic Progress"
                                  value={
                                    overview.epics.total === null || overview.epics.done === null
                                      ? '--'
                                      : `${overview.epics.done}/${overview.epics.total}`
                                  }
                                />
                                <InfoCell
                                  label="Agents"
                                  value={
                                    overview.agents.total === null
                                      ? '--'
                                      : String(overview.agents.total)
                                  }
                                />
                                <InfoCell
                                  label="Ahead/Behind"
                                  value={`${formatMaybeCount(worktree.commitsAhead)} / ${formatMaybeCount(worktree.commitsBehind)}`}
                                />
                              </div>
                              <p className="text-xs text-muted-foreground">
                                Updated {formatTimestamp(overview.fetchedAt)}
                              </p>
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={isDeleting}
                                  onClick={() => setActiveTabId(worktree.id)}
                                >
                                  Open
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={stopDisabled || isDeleting}
                                  onClick={() => void handleStopWorktree(worktree.id)}
                                >
                                  Stop
                                </Button>
                                {isMerged ? (
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    disabled={isDeleting}
                                    onClick={() => handleKeepWorktree(worktree.id)}
                                  >
                                    Keep Worktree
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    disabled={mergeDisabled || isMergeInProgress || isDeleting}
                                    onClick={() => handleOpenMergePreview(worktree)}
                                  >
                                    Merge
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  disabled={isDeleting}
                                  onClick={() => handleOpenDeleteWorktreeDialog(worktree)}
                                >
                                  Delete
                                </Button>
                              </div>
                            </CardHeader>
                          </Card>
                          {deleteError ? (
                            <p className="text-xs text-destructive">{deleteError}</p>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="space-y-3">
                <CardTitle className="text-base">Lifecycle Activity</CardTitle>
                <Separator />
              </CardHeader>
              <CardContent>
                {activityQuery.isLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading activity...
                  </div>
                ) : activityItems.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No activity yet.</p>
                ) : (
                  <div className="space-y-3">
                    {activityItems.map((item) => {
                      const visual = getActivityIconVisual(item.type);
                      return (
                        <div key={item.id} className="rounded-md border p-3">
                          <div className="flex items-start gap-2">
                            <span className={cn('mt-0.5', visual.className)}>{visual.icon}</span>
                            <div className="min-w-0">
                              <p className="text-sm font-medium">{item.message}</p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {item.worktreeName}
                              </p>
                              <p
                                className="mt-1 text-xs text-muted-foreground"
                                title={formatTimestamp(item.publishedAt)}
                              >
                                {formatRelativeTimestamp(item.publishedAt)}
                              </p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {activityQuery.error instanceof Error && (
                  <p className="mt-3 text-sm text-red-700 dark:text-red-300">
                    {activityQuery.error.message}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        ) : (
          <Card>
            <CardHeader className="space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2">
                  <GitBranch className="h-4 w-4 text-muted-foreground" />
                  <CardTitle className="text-base">
                    {selectedWorktree ? selectedWorktree.branchName : 'Select a worktree'}
                  </CardTitle>
                </div>
                {selectedWorktree && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="outline"
                      className={cn('font-medium', selectedVisual?.iconClassName)}
                    >
                      {selectedVisual?.icon} {selectedVisual?.label}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={cn(
                        'font-medium',
                        getRuntimeTypeBadgeClassName(selectedWorktree.runtimeType),
                      )}
                    >
                      {getRuntimeTypeLabel(selectedWorktree.runtimeType)}
                    </Badge>
                  </div>
                )}
              </div>
              <Separator />
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <InfoCell label="Branch" value={selectedWorktree?.branchName ?? '--'} />
                <InfoCell label="Base" value={selectedWorktree?.baseBranch ?? '--'} />
                <InfoCell
                  label="Agent Count"
                  value={selectedWorktree?.devchainProjectId ? '1' : '0'}
                />
                <InfoCell
                  label="Commits Ahead"
                  value={formatMaybeCount(selectedWorktree?.commitsAhead ?? null)}
                />
                <InfoCell
                  label="Commits Behind"
                  value={formatMaybeCount(selectedWorktree?.commitsBehind ?? null)}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                {selectedWorktree && selectedIsMerged ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => handleKeepWorktree(selectedWorktree.id)}
                  >
                    Keep Worktree
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={
                      !selectedWorktree ||
                      selectedWorktree.status === 'merged' ||
                      mergeInProgressWorktreeId === selectedWorktree.id
                    }
                    onClick={() => selectedWorktree && handleOpenMergePreview(selectedWorktree)}
                  >
                    Merge
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!selectedWorktree || selectedWorktree.status === 'stopped'}
                  onClick={() => selectedWorktree && void handleStopWorktree(selectedWorktree.id)}
                >
                  Stop
                </Button>
                {selectedWorktree && selectedIsMerged && (
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={selectedIsDeleting}
                    onClick={() => handleOpenDeleteWorktreeDialog(selectedWorktree)}
                  >
                    {selectedIsDeleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    {selectedIsDeleting ? 'Deleting...' : 'Delete Worktree'}
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {selectedDeleteError ? (
                <p className="mb-3 text-xs text-destructive">{selectedDeleteError}</p>
              ) : null}
              {showSelectedMergedNotice && selectedWorktree && (
                <div className="mb-4 rounded-md border border-emerald-300 bg-emerald-50 p-3">
                  <p className="text-sm font-medium text-emerald-800">
                    This worktree is merged. Keep it for reference or delete it now.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => handleKeepWorktree(selectedWorktree.id)}
                    >
                      Keep Worktree
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={selectedIsDeleting}
                      onClick={() => handleOpenDeleteWorktreeDialog(selectedWorktree)}
                    >
                      Delete Worktree
                    </Button>
                  </div>
                </div>
              )}

              {selectedWorktree && selectedConflictFiles.length > 0 && (
                <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3">
                  <p className="text-sm font-medium text-amber-900">Merge conflicts detected</p>
                  <ul className="mt-2 space-y-1 text-sm text-amber-900">
                    {selectedConflictFiles.map((conflict) => (
                      <li
                        key={`${conflict.type}:${conflict.file}`}
                        className="flex items-center gap-2"
                      >
                        <FileWarning className="h-4 w-4 shrink-0" />
                        <span className="font-mono text-xs">{conflict.file}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void handleResolveManually(selectedWorktree)}
                    >
                      <FolderOpen className="mr-2 h-4 w-4" />
                      Resolve Manually
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleAbortMerge(selectedWorktree)}
                    >
                      Abort Merge
                    </Button>
                  </div>
                </div>
              )}

              <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
                {selectedWorktree
                  ? `Proxy content area for "${selectedWorktree.name}" will mount here in Proxy module implementation.`
                  : 'Select a worktree tab to view container information and controls.'}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <CreateWorktreeDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        templates={templates}
        baseBranchOptions={baseBranchOptions}
        isBranchesLoading={
          branchesQuery.isLoading || (branchesQuery.isFetching && !branchesQuery.data)
        }
        branchesError={branchesQuery.error instanceof Error ? branchesQuery.error.message : null}
        isTemplatesLoading={
          templatesQuery.isLoading || (templatesQuery.isFetching && !templatesQuery.data)
        }
        templatesError={templatesQuery.error instanceof Error ? templatesQuery.error.message : null}
        dockerAvailable={runtimeQuery.data?.dockerAvailable ?? false}
        isSubmitting={createWorktreeMutation.isPending}
        onSubmit={handleCreateWorktree}
      />
      <MergePreviewDialog
        open={Boolean(mergeDialogWorktreeId)}
        onOpenChange={(value) => {
          if (!value) {
            setMergeDialogWorktreeId(null);
          }
        }}
        worktree={mergeDialogWorktree}
        preview={mergePreviewQuery.data ?? null}
        isPreviewLoading={mergePreviewQuery.isFetching || mergePreviewQuery.isLoading}
        previewError={
          mergePreviewQuery.error instanceof Error ? mergePreviewQuery.error.message : null
        }
        isMerging={mergeWorktreeMutation.isPending}
        onConfirmMerge={handleMergeWorktree}
        onResolveManually={handleResolveManually}
      />
      <DeleteWorktreeDialog
        open={Boolean(deleteDialogWorktreeId)}
        onOpenChange={(value) => {
          if (!value) {
            setDeleteDialogWorktreeId(null);
            setDeleteBranch(true);
          }
        }}
        worktree={deleteDialogWorktree}
        deleteBranch={deleteBranch}
        onDeleteBranchChange={setDeleteBranch}
        isDeleting={
          deleteDialogWorktree ? Boolean(deletingWorktreeIds[deleteDialogWorktree.id]) : false
        }
        onConfirmDelete={handleDeleteWorktree}
      />
    </main>
  );
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium">{value}</p>
    </div>
  );
}
