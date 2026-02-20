export type WorktreeStatus = 'creating' | 'running' | 'stopped' | 'completed' | 'merged' | 'error';
export type WorktreeRuntimeType = 'container' | 'process' | string;

export interface WorktreeSummary {
  id: string;
  name: string;
  branchName: string;
  baseBranch: string;
  repoPath: string;
  worktreePath: string | null;
  containerId: string | null;
  containerPort: number | null;
  templateSlug: string;
  ownerProjectId: string;
  status: WorktreeStatus | string;
  description: string | null;
  devchainProjectId: string | null;
  mergeCommit: string | null;
  mergeConflicts: string | null;
  errorMessage: string | null;
  commitsAhead: number | null;
  commitsBehind: number | null;
  runtimeType: WorktreeRuntimeType;
  processId: number | null;
  runtimeToken: string | null;
  startedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorktreeMergeConflict {
  file: string;
  type: 'merge' | 'rebase' | 'uncommitted' | string;
}

export interface WorktreeMergePreview {
  canMerge: boolean;
  commitsAhead: number;
  commitsBehind: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  conflicts: WorktreeMergeConflict[];
}

export class WorktreeApiError extends Error {
  readonly status: number;
  readonly conflicts: WorktreeMergeConflict[];
  readonly details: string | null;

  constructor({
    message,
    status,
    conflicts = [],
    details = null,
  }: {
    message: string;
    status: number;
    conflicts?: WorktreeMergeConflict[];
    details?: string | null;
  }) {
    super(message);
    this.name = 'WorktreeApiError';
    this.status = status;
    this.conflicts = conflicts;
    this.details = details;
  }
}

export interface WorktreeOverview {
  worktree: WorktreeSummary;
  epics: {
    total: number | null;
    done: number | null;
  };
  agents: {
    total: number | null;
  };
  fetchedAt: string;
}

export type WorktreeActivityType =
  | 'created'
  | 'started'
  | 'stopped'
  | 'deleted'
  | 'merged'
  | 'rebased'
  | 'error'
  | string;

export interface WorktreeActivityEvent {
  id: string;
  type: WorktreeActivityType;
  message: string;
  worktreeId: string;
  worktreeName: string;
  publishedAt: string;
}

export interface CreateWorktreeInput {
  name: string;
  branchName: string;
  baseBranch: string;
  templateSlug: string;
  ownerProjectId: string;
  description?: string;
  runtimeType?: 'container' | 'process';
  presetName?: string;
}

export interface TemplatePreset {
  name: string;
  description?: string;
}

export interface TemplateDetail {
  slug: string;
  name: string;
  description?: string;
  source?: string;
  content?: {
    presets?: TemplatePreset[];
  };
}

export interface TemplateListItem {
  slug: string;
  name: string;
}

export async function listWorktrees(opts?: {
  ownerProjectId?: string | null;
}): Promise<WorktreeSummary[]> {
  const query = new URLSearchParams();
  const ownerProjectId = opts?.ownerProjectId?.trim();
  if (ownerProjectId) {
    query.set('ownerProjectId', ownerProjectId);
  }
  const endpoint = query.size > 0 ? `/api/worktrees?${query.toString()}` : '/api/worktrees';
  const response = await fetch(endpoint, {
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Failed to load worktrees: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    throw new Error('Invalid worktree response payload');
  }

  return payload as WorktreeSummary[];
}

export async function listWorktreeOverviews(opts?: {
  ownerProjectId?: string | null;
}): Promise<WorktreeOverview[]> {
  const query = new URLSearchParams();
  const ownerProjectId = opts?.ownerProjectId?.trim();
  if (ownerProjectId) {
    query.set('ownerProjectId', ownerProjectId);
  }
  const endpoint =
    query.size > 0 ? `/api/worktrees/overview?${query.toString()}` : '/api/worktrees/overview';
  const response = await fetch(endpoint, {
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Failed to load worktree overview: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    throw new Error('Invalid worktree overview payload');
  }

  return payload as WorktreeOverview[];
}

export async function listWorktreeActivity(opts?: {
  ownerProjectId?: string | null;
}): Promise<WorktreeActivityEvent[]> {
  const query = new URLSearchParams();
  query.set('name', 'orchestrator.worktree.activity');
  query.set('limit', '20');
  const ownerProjectId = opts?.ownerProjectId?.trim();
  if (ownerProjectId) {
    query.set('ownerProjectId', ownerProjectId);
  }

  const response = await fetch(`/api/events?${query.toString()}`, {
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Failed to load worktree activity: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  const items =
    payload && typeof payload === 'object' && Array.isArray((payload as { items?: unknown }).items)
      ? ((payload as { items: unknown[] }).items ?? [])
      : null;

  if (!items) {
    throw new Error('Invalid worktree activity payload');
  }

  return items
    .map((rawItem): WorktreeActivityEvent | null => {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
        return null;
      }
      const item = rawItem as {
        id?: unknown;
        publishedAt?: unknown;
        payload?: unknown;
      };
      if (typeof item.id !== 'string' || typeof item.publishedAt !== 'string') {
        return null;
      }

      const eventPayload =
        item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
          ? (item.payload as {
              worktreeId?: unknown;
              worktreeName?: unknown;
              type?: unknown;
              message?: unknown;
            })
          : {};

      const type = typeof eventPayload.type === 'string' ? eventPayload.type : 'started';
      const worktreeName =
        typeof eventPayload.worktreeName === 'string' && eventPayload.worktreeName.trim().length > 0
          ? eventPayload.worktreeName.trim()
          : 'Unknown worktree';
      const message =
        typeof eventPayload.message === 'string' && eventPayload.message.trim().length > 0
          ? eventPayload.message.trim()
          : `Worktree '${worktreeName}' updated`;

      return {
        id: item.id,
        type,
        message,
        worktreeId:
          typeof eventPayload.worktreeId === 'string' ? eventPayload.worktreeId.trim() : '',
        worktreeName,
        publishedAt: item.publishedAt,
      };
    })
    .filter((item): item is WorktreeActivityEvent => item !== null);
}

export async function createWorktree(input: CreateWorktreeInput): Promise<WorktreeSummary> {
  const response = await fetch('/api/worktrees', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw await extractApiError(response);
  }

  return (await response.json()) as WorktreeSummary;
}

export async function stopWorktree(id: string): Promise<WorktreeSummary> {
  const response = await fetch(`/api/worktrees/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw await extractApiError(response);
  }

  return (await response.json()) as WorktreeSummary;
}

export async function deleteWorktree(
  id: string,
  options?: {
    deleteBranch?: boolean;
  },
): Promise<void> {
  const deleteBranch = options?.deleteBranch ?? true;
  const query = new URLSearchParams({
    deleteBranch: deleteBranch ? 'true' : 'false',
  }).toString();
  const response = await fetch(`/api/worktrees/${encodeURIComponent(id)}?${query}`, {
    method: 'DELETE',
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw await extractApiError(response);
  }
}

export async function previewMerge(id: string): Promise<WorktreeMergePreview> {
  const response = await fetch(`/api/worktrees/${encodeURIComponent(id)}/merge/preview`, {
    method: 'POST',
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw await extractApiError(response);
  }

  return (await response.json()) as WorktreeMergePreview;
}

export async function triggerMerge(id: string): Promise<WorktreeSummary> {
  const response = await fetch(`/api/worktrees/${encodeURIComponent(id)}/merge`, {
    method: 'POST',
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw await extractApiError(response);
  }

  return (await response.json()) as WorktreeSummary;
}

export async function listBranches(): Promise<string[]> {
  const response = await fetch('/api/branches', {
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Failed to load branches: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as { branches?: unknown }).branches)
  ) {
    throw new Error('Invalid branches response payload');
  }

  return [...new Set((payload as { branches: unknown[] }).branches)]
    .filter((branch): branch is string => typeof branch === 'string' && branch.trim().length > 0)
    .map((branch) => branch.trim())
    .sort((left, right) => left.localeCompare(right));
}

export async function listTemplates(): Promise<TemplateListItem[]> {
  const response = await fetch('/api/templates', {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Failed to load templates: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  const rawTemplates = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === 'object' &&
        Array.isArray((payload as { templates?: unknown }).templates)
      ? (payload as { templates: unknown[] }).templates
      : null;

  if (!rawTemplates) {
    throw new Error('Invalid templates response payload');
  }

  const templates = (
    rawTemplates as Array<{ id?: string; slug?: string; fileName?: string; name?: string }>
  )
    .map((template) => {
      const slug = template.slug ?? template.id;
      if (!slug) {
        return null;
      }
      return {
        slug,
        name: template.name ?? template.fileName?.replace(/\.json$/i, '') ?? slug,
      };
    })
    .filter((template): template is TemplateListItem => Boolean(template));

  if (templates.length === 0) {
    throw new Error('No templates available');
  }

  return templates;
}

export async function fetchTemplate(slug: string): Promise<TemplateDetail> {
  const response = await fetch(`/api/templates/${encodeURIComponent(slug)}`, {
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Failed to load template: HTTP ${response.status}`);
  }

  return (await response.json()) as TemplateDetail;
}

async function extractApiError(response: Response): Promise<WorktreeApiError> {
  const fallback = `Request failed with HTTP ${response.status}`;
  let text: string;
  try {
    text = (await response.text()).trim();
  } catch {
    return new WorktreeApiError({
      message: fallback,
      status: response.status,
    });
  }

  if (text.length === 0) {
    return new WorktreeApiError({
      message: fallback,
      status: response.status,
    });
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(text) as unknown;
  } catch {
    return new WorktreeApiError({
      message: text,
      status: response.status,
    });
  }

  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return new WorktreeApiError({
      message: text,
      status: response.status,
    });
  }

  const body = parsedBody as {
    message?: unknown;
    details?: unknown;
    conflicts?: unknown;
  };

  const message =
    typeof body.message === 'string' && body.message.trim().length > 0
      ? body.message.trim()
      : Array.isArray(body.message) && body.message.length > 0
        ? String(body.message[0] ?? fallback)
        : fallback;

  const conflicts = Array.isArray(body.conflicts)
    ? body.conflicts
        .map((item): WorktreeMergeConflict | null => {
          if (!item || typeof item !== 'object') {
            return null;
          }
          const parsed = item as { file?: unknown; type?: unknown };
          if (typeof parsed.file !== 'string' || parsed.file.trim().length === 0) {
            return null;
          }
          return {
            file: parsed.file.trim(),
            type: typeof parsed.type === 'string' ? parsed.type : 'merge',
          };
        })
        .filter((item): item is WorktreeMergeConflict => item !== null)
    : [];

  return new WorktreeApiError({
    message,
    status: response.status,
    conflicts,
    details: typeof body.details === 'string' ? body.details : null,
  });
}
