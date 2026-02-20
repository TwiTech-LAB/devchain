// ── Public types ───────────────────────────────────────────────────

/** Progress update during a move operation */
export interface MoveProgress {
  phase: 'extracting' | 'mapping' | 'creating' | 'copying-comments' | 'deleting-source';
  current: number;
  total: number;
  message: string;
}

/** Parameters for moving an epic tree to a destination worktree */
export interface MoveEpicToWorktreeParams {
  /** Source epic ID (parent epic to move) */
  epicId: string;
  /** Destination worktree name (for API routing via /wt/{name}/api/*) */
  destWorktreeName: string;
  /** Destination project ID (from WorktreeSummary.devchainProjectId) */
  destProjectId: string;
  /** Status mapping: source status ID → destination status ID (unmapped = will be created) */
  statusMap: Record<string, string>;
  /** Agent mapping: source agent ID → destination agent ID | null (null = unassign) */
  agentMap: Record<string, string | null>;
  /** Progress callback invoked during each phase of the move */
  onProgress?: (progress: MoveProgress) => void;
}

/** Result of a successful move operation */
export interface MoveEpicResult {
  /** The ID of the created parent epic in the destination worktree */
  destEpicId: string;
  /** Warnings encountered during the move (non-fatal issues) */
  warnings: string[];
}

// ── Internal types ─────────────────────────────────────────────────

interface SourceEpic {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  statusId: string;
  parentId: string | null;
  agentId: string | null;
  version: number;
  data: Record<string, unknown> | null;
  skillsRequired: string[] | null;
  tags: string[];
}

interface SourceComment {
  authorName: string;
  content: string;
}

interface SourceStatus {
  id: string;
  label: string;
  color: string;
  position: number;
}

interface EpicNode {
  epic: SourceEpic;
  children: EpicNode[];
  comments: SourceComment[];
}

interface ListResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

interface MappingResult {
  statusMap: Record<string, string>;
  agentMap: Record<string, string | null>;
  createdStatusIds: string[];
  warnings: string[];
}

// ── Fetch utilities ────────────────────────────────────────────────

const PAGE_SIZE = 1000;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body || res.statusText}`);
  }
  return res.json();
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

async function deleteRequest(url: string): Promise<void> {
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
}

/** Fetch all pages from a paginated list endpoint */
async function fetchAllPages<T>(baseUrl: string): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  const sep = baseUrl.includes('?') ? '&' : '?';

  for (;;) {
    const data = await fetchJson<ListResult<T>>(
      `${baseUrl}${sep}limit=${PAGE_SIZE}&offset=${offset}`,
    );
    const items = data.items ?? [];
    all.push(...items);
    if (items.length < PAGE_SIZE || all.length >= data.total) break;
    offset += PAGE_SIZE;
  }

  return all;
}

/** Normalize API responses that may be { items: T[] } or T[] */
function normalizeList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (
    data &&
    typeof data === 'object' &&
    'items' in data &&
    Array.isArray((data as { items: unknown }).items)
  ) {
    return (data as { items: T[] }).items;
  }
  return [];
}

// ── Tree helpers ───────────────────────────────────────────────────

/** BFS flatten of the epic tree (root first) */
function flattenTree(root: EpicNode): EpicNode[] {
  const result: EpicNode[] = [];
  const queue: EpicNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    result.push(node);
    queue.push(...node.children);
  }
  return result;
}

// ── Phase 1: Extract source tree ───────────────────────────────────

async function extractSourceTree(
  epicId: string,
  onProgress?: (p: MoveProgress) => void,
): Promise<EpicNode> {
  onProgress?.({
    phase: 'extracting',
    current: 0,
    total: 0,
    message: 'Reading source epic…',
  });

  // Fetch the parent epic
  const parent = await fetchJson<SourceEpic>(`/api/epics/${encodeURIComponent(epicId)}`);

  // BFS to collect all descendants (handles arbitrarily deep trees)
  const root: EpicNode = { epic: parent, children: [], comments: [] };
  const queue: EpicNode[] = [root];
  const allNodes: EpicNode[] = [root];

  while (queue.length > 0) {
    const node = queue.shift()!;
    const children = await fetchAllPages<SourceEpic>(
      `/api/epics?parentId=${encodeURIComponent(node.epic.id)}`,
    );
    for (const child of children) {
      const childNode: EpicNode = {
        epic: child,
        children: [],
        comments: [],
      };
      node.children.push(childNode);
      allNodes.push(childNode);
      queue.push(childNode);
    }
  }

  // Fetch comments for every epic in the tree (paginated)
  for (let i = 0; i < allNodes.length; i++) {
    const node = allNodes[i];
    onProgress?.({
      phase: 'extracting',
      current: i + 1,
      total: allNodes.length,
      message: `Reading comments (${i + 1}/${allNodes.length})`,
    });
    node.comments = await fetchAllPages<SourceComment>(
      `/api/epics/${encodeURIComponent(node.epic.id)}/comments`,
    );
  }

  return root;
}

// ── Phase 2: Map references ────────────────────────────────────────

async function mapReferences(
  tree: EpicNode,
  destName: string,
  destProjectId: string,
  preResolvedStatusMap: Record<string, string>,
  preResolvedAgentMap: Record<string, string | null>,
  onProgress?: (p: MoveProgress) => void,
): Promise<MappingResult> {
  onProgress?.({
    phase: 'mapping',
    current: 0,
    total: 0,
    message: 'Mapping statuses and agents…',
  });

  const allNodes = flattenTree(tree);

  // Collect unique source statusIds actually used in the tree
  const usedStatusIds = new Set<string>();
  for (const node of allNodes) {
    usedStatusIds.add(node.epic.statusId);
  }

  // Fetch source statuses (for label/color when creating new ones)
  const sourceProjectId = tree.epic.projectId;
  const sourceStatusData = await fetchJson<unknown>(
    `/api/statuses?projectId=${encodeURIComponent(sourceProjectId)}`,
  );
  const sourceStatusList = normalizeList<SourceStatus>(sourceStatusData);
  const sourceStatusById = new Map(sourceStatusList.map((s) => [s.id, s]));

  // Fetch destination statuses (for matching and max position)
  const destBase = `/wt/${encodeURIComponent(destName)}/api`;
  const destStatusData = await fetchJson<unknown>(
    `${destBase}/statuses?projectId=${encodeURIComponent(destProjectId)}`,
  );
  const destStatusList = normalizeList<SourceStatus>(destStatusData);

  // Build final status map
  const finalStatusMap: Record<string, string> = { ...preResolvedStatusMap };
  const createdStatusIds: string[] = [];
  const warnings: string[] = [];
  let maxDestPosition = destStatusList.reduce((max, s) => Math.max(max, s.position), -1);

  for (const srcId of usedStatusIds) {
    if (finalStatusMap[srcId]) continue; // already resolved by dialog

    const srcStatus = sourceStatusById.get(srcId);
    if (!srcStatus) {
      // Source status doesn't exist — use first dest status as fallback
      warnings.push(`Source status ${srcId} not found; using default destination status`);
      if (destStatusList.length > 0) {
        finalStatusMap[srcId] = destStatusList[0].id;
      }
      continue;
    }

    // Try to match by label (case-insensitive) in destination
    const matches = destStatusList.filter(
      (d) => d.label.toLowerCase() === srcStatus.label.toLowerCase(),
    );

    if (matches.length === 1) {
      finalStatusMap[srcId] = matches[0].id;
    } else if (matches.length > 1) {
      // Ambiguous — should have been disambiguated by dialog; use first as fallback
      finalStatusMap[srcId] = matches[0].id;
      warnings.push(`Ambiguous status "${srcStatus.label}" — used first match`);
    } else {
      // No match — create status in destination with safe position
      maxDestPosition += 1;
      const created = await postJson<SourceStatus>(`${destBase}/statuses`, {
        projectId: destProjectId,
        label: srcStatus.label,
        color: srcStatus.color,
        position: maxDestPosition,
      });
      finalStatusMap[srcId] = created.id;
      createdStatusIds.push(created.id);
    }
  }

  // Build final agent map from pre-resolved dialog values
  // For agents not in the pre-resolved map, default to null (unassigned)
  const finalAgentMap: Record<string, string | null> = {
    ...preResolvedAgentMap,
  };
  for (const node of allNodes) {
    const aid = node.epic.agentId;
    if (aid && !(aid in finalAgentMap)) {
      finalAgentMap[aid] = null;
      warnings.push(`Agent for epic "${node.epic.title}" not mapped — will be unassigned`);
    }
  }

  return {
    statusMap: finalStatusMap,
    agentMap: finalAgentMap,
    createdStatusIds,
    warnings,
  };
}

// ── Phase 3: Create in destination ─────────────────────────────────

async function createInDestination(
  tree: EpicNode,
  destName: string,
  destProjectId: string,
  statusMap: Record<string, string>,
  agentMap: Record<string, string | null>,
  createdEpicIds: string[], // mutated — accumulates IDs for rollback
  onProgress?: (p: MoveProgress) => void,
): Promise<string> {
  const destBase = `/wt/${encodeURIComponent(destName)}/api`;
  const allNodes = flattenTree(tree);
  const totalEpics = allNodes.length;
  const sourceToDestId = new Map<string, string>();
  let epicCounter = 0;

  // DFS creation preserves parent-child hierarchy
  async function createNode(node: EpicNode, destParentId: string | null): Promise<string> {
    epicCounter++;
    onProgress?.({
      phase: 'creating',
      current: epicCounter,
      total: totalEpics,
      message: `Creating epic ${epicCounter}/${totalEpics}`,
    });

    // Build tags — add idempotency tag to root epic only
    const tags = [...(node.epic.tags ?? [])];
    if (destParentId === null) {
      tags.push(`moved-from:${node.epic.id}`);
    }

    const body = {
      projectId: destProjectId,
      title: node.epic.title,
      description: node.epic.description,
      statusId: statusMap[node.epic.statusId] ?? node.epic.statusId,
      parentId: destParentId,
      agentId: node.epic.agentId ? (agentMap[node.epic.agentId] ?? null) : null,
      tags,
      data: node.epic.data,
      skillsRequired: node.epic.skillsRequired,
    };

    const created = await postJson<{ id: string }>(`${destBase}/epics`, body);
    createdEpicIds.push(created.id);
    sourceToDestId.set(node.epic.id, created.id);

    // Recursively create children (depth-first)
    for (const child of node.children) {
      await createNode(child, created.id);
    }

    return created.id;
  }

  // Create the tree starting from root (parentId = null)
  const destParentId = await createNode(tree, null);

  // Copy comments for all epics
  const totalComments = allNodes.reduce((sum, n) => sum + n.comments.length, 0);
  let commentCounter = 0;

  for (const node of allNodes) {
    const destEpicId = sourceToDestId.get(node.epic.id);
    if (!destEpicId) continue;

    for (const comment of node.comments) {
      commentCounter++;
      onProgress?.({
        phase: 'copying-comments',
        current: commentCounter,
        total: totalComments,
        message: `Copying comments (${commentCounter}/${totalComments})`,
      });
      await postJson(`${destBase}/epics/${encodeURIComponent(destEpicId)}/comments`, {
        authorName: comment.authorName,
        content: comment.content,
      });
    }
  }

  return destParentId;
}

// ── Rollback ───────────────────────────────────────────────────────

async function rollbackCreatedEpics(destName: string, createdEpicIds: string[]): Promise<void> {
  const destBase = `/wt/${encodeURIComponent(destName)}/api`;
  // Delete in reverse order (children first, parent last)
  for (const id of [...createdEpicIds].reverse()) {
    try {
      await deleteRequest(`${destBase}/epics/${encodeURIComponent(id)}`);
    } catch {
      // Best-effort rollback — continue even if individual deletes fail
    }
  }
}

async function rollbackCreatedStatuses(
  destName: string,
  createdStatusIds: string[],
): Promise<void> {
  const destBase = `/wt/${encodeURIComponent(destName)}/api`;
  for (const id of createdStatusIds) {
    try {
      await deleteRequest(`${destBase}/statuses/${encodeURIComponent(id)}`);
    } catch {
      // Best-effort rollback
    }
  }
}

// ── Main orchestrator ──────────────────────────────────────────────

/**
 * Move an epic (with all sub-epics and comments) to a destination worktree.
 *
 * Algorithm:
 * 1. Extract: BFS traversal of source epic tree + all comments (paginated)
 * 2. Map: Resolve statuses (match by label, create if missing) and agents
 * 3. Create: Depth-first creation in destination via /wt/{name}/api/*
 * 4. Delete: Remove source tree (cascade) — warning on failure, not error
 *
 * Rollback: If phase 3 fails partially, all created epics and statuses
 * in the destination are cleaned up before re-throwing.
 */
export async function moveEpicToWorktree(
  params: MoveEpicToWorktreeParams,
): Promise<MoveEpicResult> {
  const { epicId, destWorktreeName, destProjectId, statusMap, agentMap, onProgress } = params;

  // Phase 1: Extract source tree (recursive + paginated)
  const tree = await extractSourceTree(epicId, onProgress);

  // Phase 2: Map statuses and agents
  const mapping = await mapReferences(
    tree,
    destWorktreeName,
    destProjectId,
    statusMap,
    agentMap,
    onProgress,
  );

  // Phase 3: Create in destination (with rollback on failure)
  // createdEpicIds is mutated by createInDestination so rollback can
  // access partially-created IDs even if the function throws.
  const createdEpicIds: string[] = [];
  let destParentId: string;

  try {
    destParentId = await createInDestination(
      tree,
      destWorktreeName,
      destProjectId,
      mapping.statusMap,
      mapping.agentMap,
      createdEpicIds,
      onProgress,
    );
  } catch (err) {
    // Rollback: clean up created epics and statuses in destination
    await rollbackCreatedEpics(destWorktreeName, createdEpicIds);
    await rollbackCreatedStatuses(destWorktreeName, mapping.createdStatusIds);
    throw new Error(
      `Move failed during creation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Phase 4: Delete source tree
  const warnings = [...mapping.warnings];
  onProgress?.({
    phase: 'deleting-source',
    current: 1,
    total: 1,
    message: 'Removing source epic…',
  });

  try {
    await deleteRequest(`/api/epics/${encodeURIComponent(epicId)}`);
  } catch {
    // Source delete failure is a warning, not an error — epic exists in both places
    warnings.push(
      `Epic was copied to worktree but not removed from source. Look for tag moved-from:${epicId}`,
    );
  }

  return { destEpicId: destParentId, warnings };
}
