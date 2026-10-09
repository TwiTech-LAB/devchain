/**
 * Shared domain type definitions for UI components.
 * These types represent API response shapes used across multiple features.
 */

export type { Status } from '@/ui/lib/statuses';

/** Epic entity from the API */
export interface Epic {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  statusId: string;
  version: number;
  parentId: string | null;
  agentId: string | null;
  createdBy: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export type { Agent } from '@/ui/lib/agents';

/** Response shape for paginated epics queries */
export interface EpicsQueryData {
  items: Epic[];
  total?: number;
  limit?: number;
  offset?: number;
}
