import type { WorktreesService } from '../../worktrees/worktrees.service';
import type { WorktreeToolContext } from '../services/handlers/worktree-context';
import {
  handleWorktreesCreate,
  handleWorktreesList,
  handleWorktreesCommit,
  handleWorktreesMerge,
  handleWorktreesRemove,
} from '../services/handlers/worktree-tools';
import { createNullAdapter } from '../services/handlers/null-adapter';
import { defineToolGroup, type McpBindingRuntime } from './binding-types';

function createWorktreeContext(runtime: McpBindingRuntime): WorktreeToolContext {
  return {
    worktreesService:
      runtime.worktreesService ?? createNullAdapter<WorktreesService>('WorktreesService'),
    resolveSessionContext: runtime.resolveSessionContext,
  };
}

export const worktreeBindings = defineToolGroup<WorktreeToolContext>(createWorktreeContext, [
  ['devchain_worktrees_create', handleWorktreesCreate],
  ['devchain_worktrees_list', handleWorktreesList],
  ['devchain_worktrees_commit', handleWorktreesCommit],
  ['devchain_worktrees_merge', handleWorktreesMerge],
  ['devchain_worktrees_remove', handleWorktreesRemove],
]);
