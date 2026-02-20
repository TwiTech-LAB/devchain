export type CreateWorktreeRecordInput = Pick<
  WorktreeRecord,
  'name' | 'branchName' | 'baseBranch' | 'repoPath' | 'templateSlug' | 'ownerProjectId'
> &
  Partial<Omit<WorktreeRecord, 'id' | 'createdAt' | 'updatedAt'>> &
  Partial<Pick<WorktreeRecord, 'id' | 'createdAt' | 'updatedAt'>>;

export type UpdateWorktreeRecordInput = Partial<Omit<WorktreeRecord, 'id' | 'createdAt'>>;

export interface WorktreeRecord {
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
  status: string;
  description: string | null;
  devchainProjectId: string | null;
  mergeCommit: string | null;
  mergeConflicts: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  runtimeType?: string;
  processId?: number | null;
  runtimeToken?: string | null;
  startedAt?: Date | null;
}

export const WORKTREES_STORE = 'WORKTREES_STORE';

export interface WorktreesStore {
  create(data: CreateWorktreeRecordInput): Promise<WorktreeRecord>;
  list(): Promise<WorktreeRecord[]>;
  listByOwnerProject(ownerProjectId: string): Promise<WorktreeRecord[]>;
  getById(id: string): Promise<WorktreeRecord | null>;
  getByName(name: string): Promise<WorktreeRecord | null>;
  getByContainerId(containerId: string): Promise<WorktreeRecord | null>;
  listMonitored(): Promise<WorktreeRecord[]>;
  update(id: string, patch: UpdateWorktreeRecordInput): Promise<WorktreeRecord | null>;
  remove(id: string): Promise<void>;
}
