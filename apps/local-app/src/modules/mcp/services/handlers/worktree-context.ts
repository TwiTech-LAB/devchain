import type { WorktreesService } from '../../../worktrees/worktrees.service';
import type { McpResponse } from '../../dtos/mcp.dto';

export interface WorktreeToolContext {
  worktreesService: WorktreesService;
  resolveSessionContext: (sessionId: string) => Promise<McpResponse>;
}
