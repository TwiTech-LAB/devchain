import { WorktreeError } from '../../../worktrees/worktrees.errors';
import type { WorktreesService } from '../../../worktrees/worktrees.service';
import type { AgentSessionContext, McpResponse } from '../../dtos/mcp.dto';
import type { WorktreeToolContext } from './worktree-context';
import {
  handleWorktreesCreate,
  handleWorktreesList,
  handleWorktreesCommit,
  handleWorktreesMerge,
  handleWorktreesRemove,
} from './worktree-tools';

// Unit tests exercise MCP dispatch and refusal projection; Git invariants belong to the service suite.
const projectId = '00000000-0000-0000-0000-000000000001';
const agentId = '00000000-0000-0000-0000-000000000002';
const sessionId = '00000000-0000-0000-0000-000000000003';
const epicId = '00000000-0000-0000-0000-000000000004';
const sha = 'a'.repeat(40);

const operations = [
  {
    method: 'create',
    handler: handleWorktreesCreate,
    params: { sessionId, name: 'task', baseRef: 'main', epicId },
    args: [projectId, agentId, { name: 'task', baseRef: 'main', epicId }],
    result: {
      name: 'task',
      path: '/lane',
      branch: 'devchain/task-123456',
      projectRootPath: '/root',
    },
  },
  {
    method: 'list',
    handler: handleWorktreesList,
    params: { sessionId, name: 'task' },
    args: [projectId, agentId, 'task'],
    result: { lanes: [], rootDirtyFiles: [], preview: { status: 'clean', files: [] } },
  },
  {
    method: 'commit',
    handler: handleWorktreesCommit,
    params: { sessionId, name: 'task', message: 'finish' },
    args: [projectId, agentId, 'task', 'finish'],
    result: { sha, files: ['file.ts'] },
  },
  {
    method: 'merge',
    handler: handleWorktreesMerge,
    params: { sessionId, name: 'task', expectedHead: sha },
    args: [projectId, agentId, 'task', sha],
    result: { baseBranch: 'main', oldSha: 'b'.repeat(40), newSha: sha },
  },
  {
    method: 'remove',
    handler: handleWorktreesRemove,
    params: { sessionId, name: 'task' },
    args: [projectId, agentId, 'task'],
    result: {
      status: 'removed',
      branch: 'devchain/task-123456',
      deletedIgnoredPaths: ['node_modules/file'],
      deletedIgnoredPathCount: 1,
      ignoredPathsTruncated: false,
    },
  },
] as const;

function fixture() {
  const session: AgentSessionContext = {
    type: 'agent',
    session: { id: sessionId, agentId, status: 'running', startedAt: '' },
    agent: { id: agentId, name: 'Lead', projectId },
    project: { id: projectId, name: 'Project', rootPath: '/root' },
  };
  const service = {
    create: jest.fn(),
    list: jest.fn(),
    commit: jest.fn(),
    merge: jest.fn(),
    remove: jest.fn(),
  };
  const resolve = jest
    .fn<Promise<McpResponse>, [string]>()
    .mockResolvedValue({ success: true, data: session });
  const ctx: WorktreeToolContext = {
    worktreesService: service as unknown as WorktreesService,
    resolveSessionContext: resolve,
  };
  return { ctx, service, session, resolve };
}

describe('worktree MCP handlers', () => {
  it.each(operations)(
    '$method returns the service result using the session project and lead',
    async ({ method, handler, params, args, result }) => {
      const { ctx, service } = fixture();
      service[method].mockResolvedValue(result);
      await expect(handler(ctx, params)).resolves.toEqual({ success: true, data: result });
      expect(service[method]).toHaveBeenCalledWith(...args);
    },
  );

  it.each(operations)(
    '$method preserves the service non-lead refusal',
    async ({ method, handler, params }) => {
      const { ctx, service } = fixture();
      service[method].mockRejectedValue(
        new WorktreeError(
          'FORBIDDEN_NOT_TEAM_LEAD',
          'You do not lead any teams in this project.',
          403,
        ),
      );
      await expect(handler(ctx, params)).resolves.toMatchObject({
        success: false,
        error: {
          code: 'FORBIDDEN_NOT_TEAM_LEAD',
          message: 'You do not lead any teams in this project.',
        },
      });
    },
  );

  it.each([
    { kind: 'guest', code: 'AGENT_CONTEXT_REQUIRED' },
    { kind: 'missing agent', code: 'AGENT_REQUIRED' },
  ])('refuses $kind before invoking the service', async ({ kind, code }) => {
    const { ctx, service, session, resolve } = fixture();
    resolve.mockResolvedValue({
      success: true,
      data:
        kind === 'guest'
          ? { type: 'guest', project: session.project }
          : { ...session, agent: null },
    });
    await expect(handleWorktreesCreate(ctx, { sessionId })).resolves.toMatchObject({
      success: false,
      error: { code },
    });
    expect(service.create).not.toHaveBeenCalled();
  });

  it('preserves BEHIND recovery and conflict-preview details', async () => {
    const { ctx, service } = fixture();
    const details = {
      ahead: 1,
      behind: 2,
      preview: { status: 'conflicts', files: ['file.ts'] },
      recovery: 'Merge the base, resolve, test and commit.',
    };
    service.merge.mockRejectedValue(
      new WorktreeError('BEHIND', 'Lane is behind its base', 409, details),
    );
    await expect(
      handleWorktreesMerge(ctx, { sessionId, name: 'task', expectedHead: sha }),
    ).resolves.toEqual({
      success: false,
      error: { code: 'BEHIND', message: 'Lane is behind its base', data: details },
    });
  });

  it('propagates unexpected failures to the protocol error boundary', async () => {
    const { ctx, service } = fixture();
    const error = new Error('unexpected');
    service.create.mockRejectedValue(error);
    await expect(handleWorktreesCreate(ctx, { sessionId })).rejects.toBe(error);
  });
});
