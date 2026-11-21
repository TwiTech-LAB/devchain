import { z } from 'zod';
import { IgnorePatternsSchema, ShareIdSchema } from '../../file-sync/file-sync.dto';

export const SharedFolderEntrySchema = z.object({
  /** The share id: a hash of `path`, the same on both sides. */
  id: ShareIdSchema,
  remoteId: z.string().uuid(),
  /** Absolute, as written: links are not resolved, so it is the same path on the VM. */
  path: z.string().min(1),
  ignores: IgnorePatternsSchema,
  /** False when the last pattern save did not reach both sides. */
  patternsApplied: z.boolean(),
  createdAt: z.string(),
});
export type SharedFolderEntry = z.infer<typeof SharedFolderEntrySchema>;

export const CreateSharedFolderSchema = z
  .object({ path: z.string().min(1).max(4096), ignores: IgnorePatternsSchema.default([]) })
  .strict();
export type CreateSharedFolderRequest = z.infer<typeof CreateSharedFolderSchema>;

export const UpdateSharedFolderIgnoresSchema = z.object({ ignores: IgnorePatternsSchema }).strict();

export type SharedFolderState =
  | { kind: 'sharing'; operationId: string }
  | { kind: 'failed'; operationId: string; message: string | null }
  | { kind: 'in-sync' }
  | { kind: 'syncing'; needItems: number }
  | { kind: 'failing'; failedFiles: number }
  | { kind: 'error'; message: string }
  | { kind: 'vm-offline' }
  | { kind: 'not-on-vm' };

export interface SharedFolderDto extends SharedFolderEntry {
  state: SharedFolderState;
}

export interface StopSharingResult {
  /** False when the VM did not answer; its folder stays shared there until the VM is cleaned up. */
  vmRemoved: boolean;
  message: string;
}

export { SHARED_FOLDER_MISSING } from '../../file-sync/file-sync.dto';
export const SHARED_FOLDER_OVERLAP = 'SHARED_FOLDER_OVERLAP';
export const SHARED_FOLDER_PATTERNS_NOT_APPLIED = 'SHARED_FOLDER_PATTERNS_NOT_APPLIED';
