import type { McpResponse } from '../../dtos/mcp.dto';
import type { ExternalTaskReadDeps } from './external-task-resolution';

export interface ExternalTaskToolContext extends ExternalTaskReadDeps {
  resolveSessionContext: (sessionId: string) => Promise<McpResponse>;
}
