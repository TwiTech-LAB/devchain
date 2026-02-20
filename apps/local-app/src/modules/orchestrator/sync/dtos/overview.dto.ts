export type WorktreeSnapshotStatus =
  | 'creating'
  | 'running'
  | 'stopped'
  | 'completed'
  | 'merged'
  | 'error'
  | string;

export interface WorktreeSnapshot {
  worktreeId: string;
  worktreeName: string;
  branchName: string;
  status: WorktreeSnapshotStatus;
  git: {
    commitsAhead: number;
    commitsBehind: number;
  };
  live?: {
    epics: {
      total: number;
      byStatus: Record<string, number>;
    };
    agents: {
      total: number;
      active: number;
    };
    fetchedAt: string;
    error?: string;
  };
  merged?: {
    epicCount: number;
    agentCount: number;
    mergeCommit: string | null;
    mergedAt: string;
  };
  fetchedAt: string;
}

export interface MergedEpicDto {
  id: string;
  worktreeId: string;
  devchainEpicId: string;
  title: string;
  description: string | null;
  statusName: string | null;
  statusColor: string | null;
  agentName: string | null;
  parentEpicId: string | null;
  tags: string[];
  createdAtSource: string | null;
  mergedAt: string;
}

export interface MergedEpicHierarchyNodeDto extends MergedEpicDto {
  children: MergedEpicHierarchyNodeDto[];
}

export interface MergedEpicHierarchyDto {
  worktreeId: string;
  total: number;
  roots: MergedEpicHierarchyNodeDto[];
}
