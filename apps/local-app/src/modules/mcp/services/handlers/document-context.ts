import type { DocumentStorage } from '../../../storage/interfaces/storage.interface';
import type { McpResponse } from '../../dtos/mcp.dto';

export type DocumentToolStorage = DocumentStorage;

export interface DocumentToolContext {
  storage: DocumentToolStorage;
  defaultInlineMaxBytes: number;
  resolveSessionContext: (sessionId: string) => Promise<McpResponse>;
}
