import type { ChatService } from '../../../chat/services/chat.service';
import type { McpResponse } from '../../dtos/mcp.dto';

export interface ActivityToolContext {
  chatService: ChatService;
  resolveSessionContext: (sessionId: string) => Promise<McpResponse>;
}
