import type { ProjectCommunicationService } from '../../../project-communication/project-communication.service';
import type { McpResponse } from '../../dtos/mcp.dto';

export interface ProjectToolContext {
  projectCommunicationService: ProjectCommunicationService;
  resolveSessionContext: (sessionId: string) => Promise<McpResponse>;
}
