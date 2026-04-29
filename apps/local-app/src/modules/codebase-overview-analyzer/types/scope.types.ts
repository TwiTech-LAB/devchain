export type FolderPurpose = 'source' | 'test-source' | 'generated' | 'resources' | 'excluded';
export type ScopeEntryOrigin = 'default' | 'user';

export interface FolderScopeEntry {
  folder: string;
  purpose: FolderPurpose;
  reason: string;
  origin: ScopeEntryOrigin;
}

export interface ScopeConfig {
  schemaVersion: 1;
  entries: FolderScopeEntry[];
}
