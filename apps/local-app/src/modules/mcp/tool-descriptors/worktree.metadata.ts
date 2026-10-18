import {
  WorktreesCreateParamsSchema,
  WorktreesListParamsSchema,
  WorktreesCommitParamsSchema,
  WorktreesMergeParamsSchema,
  WorktreesRemoveParamsSchema,
} from '../dtos/mcp.dto';
import type { ToolMetadataEntry } from './types';

const sessionId = {
  type: 'string',
  minLength: 8,
  description: 'Session ID (full UUID or 8+ char prefix)',
};
const name = {
  type: 'string',
  pattern: '^\\s*[a-zA-Z0-9-]{1,40}\\s*$',
  description: 'Lane name (trimmed, case-insensitive lookup)',
};

export const worktreeMetadata: ToolMetadataEntry[] = [
  {
    name: 'devchain_worktrees_create',
    description:
      'Creates a git worktree (lane) for one task, outside the project root. Team leads only. The lane contains tracked files only. The agent that works in it must set it up: install dependencies and copy needed ignored files, such as .env, from the project root. Agents keep running in the project root and work in the lane by path: start every shell command with `cd <lane> &&`, use `git -C <lane>`, and use absolute file paths. Link the lane to the task with epicId, so the worker sees it in devchain_get_epic_by_id. WORKTREE_SETUP_FAILED means Git registered the lane but a checkout hook failed; the lane and hook-created files remain managed. Inspect it or remove it with devchain_worktrees_remove.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId,
        name: {
          type: 'string',
          pattern: '^[a-z0-9-]{1,40}$',
          description:
            'Optional lowercase lane slug; defaults to the task title or an available lane-N name',
        },
        baseRef: {
          type: 'string',
          minLength: 1,
          description: 'Optional base branch; defaults to the branch checked out in the root',
        },
        epicId: {
          type: 'string',
          format: 'uuid',
          description: 'Optional task UUID in the current project to link to this lane',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: WorktreesCreateParamsSchema,
  },
  {
    name: 'devchain_worktrees_list',
    description:
      "Lists lane status, head, ahead/behind, dirty files, and linked task with its assignee. Team leads only. Includes the project root's dirty files as a drift warning. With name, returns that lane and a merge-tree conflict preview. Live state is computed from git.",
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: { sessionId, name },
      additionalProperties: false,
    },
    paramsSchema: WorktreesListParamsSchema,
  },
  {
    name: 'devchain_worktrees_commit',
    description:
      'Commits all tracked and untracked changes in a lane using normal git hooks and signing. Team leads only. Refuses unresolved merge paths (UNMERGED_PATHS), leftover conflict markers (CONFLICT_MARKERS), and nothing to commit (NOTHING_TO_COMMIT); hook or signing failures return COMMIT_FAILED. Finishes a merge in progress after its conflicts are resolved. Returns the commit SHA and committed files.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'name', 'message'],
      properties: {
        sessionId,
        name,
        message: {
          type: 'string',
          minLength: 1,
          description: 'Commit message; must not be whitespace-only',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: WorktreesCommitParamsSchema,
  },
  {
    name: 'devchain_worktrees_merge',
    description:
      "Lands exactly expectedHead by fast-forward only. Team leads only. The lane's base branch must be checked out in the project root. Refuses a dirty lane, an unfinished merge, or a head differing from the reviewed commit. On BEHIND, ask the worker to run `git -C <lane> merge <baseBranch>`, resolve conflicts, and test; then commit the lane and retry with the new reviewed SHA. Passes through Git's refusal when root changes overlap.",
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'name', 'expectedHead'],
      properties: {
        sessionId,
        name,
        expectedHead: {
          type: 'string',
          pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$',
          description: 'Full reviewed commit SHA; must equal the current lane head',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: WorktreesMergeParamsSchema,
  },
  {
    name: 'devchain_worktrees_remove',
    description:
      'Removes a lane. Team leads only. Refuses uncommitted tracked or untracked work (WORKTREE_DIRTY) and ignored .env* files without identical project-root copies (WORKTREE_LOCAL_ENV). Deletes other ignored files and reports their paths/count; the branch is kept. A missing directory prunes git metadata and deletes the lane record.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'name'],
      properties: { sessionId, name },
      additionalProperties: false,
    },
    paramsSchema: WorktreesRemoveParamsSchema,
  },
];
