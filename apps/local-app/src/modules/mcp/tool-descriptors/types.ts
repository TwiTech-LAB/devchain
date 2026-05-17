import type { ZodSchema } from 'zod';
import type { McpToolHandler } from '../services/handlers/types';

export interface ToolMetadataEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  paramsSchema: ZodSchema | null;
}

export type ToolBindingEntry = [string, McpToolHandler];
