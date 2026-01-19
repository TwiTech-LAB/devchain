/**
 * Shared domain type definitions for UI components.
 * These types represent API response shapes used across multiple features.
 */

/** Status entity from the API */
export interface Status {
  id: string;
  projectId: string;
  label: string;
  color: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

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
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** Agent entity from the API */
export interface Agent {
  id: string;
  projectId: string;
  profileId: string;
  name: string;
}

/** Response shape for paginated epics queries */
export interface EpicsQueryData {
  items: Epic[];
  total?: number;
  limit?: number;
  offset?: number;
}
