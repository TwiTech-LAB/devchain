import { getTableColumns } from 'drizzle-orm';
import { mergedAgents, mergedEpics, worktrees } from './schema';

describe('Main SQLite orchestrator schema', () => {
  it('defines worktrees with legacy and process runtime columns', () => {
    const columns = getTableColumns(worktrees);
    expect(Object.keys(columns)).toEqual(
      expect.arrayContaining([
        'id',
        'name',
        'branchName',
        'baseBranch',
        'repoPath',
        'worktreePath',
        'containerId',
        'containerPort',
        'templateSlug',
        'ownerProjectId',
        'status',
        'description',
        'devchainProjectId',
        'mergeCommit',
        'mergeConflicts',
        'errorMessage',
        'runtimeType',
        'processId',
        'runtimeToken',
        'startedAt',
        'createdAt',
        'updatedAt',
      ]),
    );
  });

  it('defines merged history tables with linkage and uniqueness columns', () => {
    const epicColumns = getTableColumns(mergedEpics);
    const agentColumns = getTableColumns(mergedAgents);

    expect(Object.keys(epicColumns)).toEqual(
      expect.arrayContaining(['id', 'worktreeId', 'devchainEpicId', 'title', 'tags', 'mergedAt']),
    );
    expect(Object.keys(agentColumns)).toEqual(
      expect.arrayContaining([
        'id',
        'worktreeId',
        'devchainAgentId',
        'profileName',
        'epicsCompleted',
        'mergedAt',
      ]),
    );
  });
});
