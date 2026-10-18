import { z } from 'zod';
import type { GitOwner } from '../git-owner.store';
import type { GitCheckpointSchema } from '../git-coordinator/git-coordinator.dto';

export const GitOwnerStatusQuerySchema = z.object({ projectId: z.string().min(1) }).strict();

export const RemoteSessionSchema = z.object({
  id: z.string(),
  agentId: z.string().nullable(),
  status: z.enum(['running', 'stopped', 'failed']),
  startedAt: z.string().datetime(),
  activityState: z.enum(['busy', 'idle']).nullable().optional().default(null),
  busySince: z.string().nullable().optional().default(null),
});
export type RemoteSession = z.infer<typeof RemoteSessionSchema>;

export interface GitOwnerStatus {
  connected: boolean;
  remoteId: string | null;
  remoteName: string | null;
  owner: GitOwner;
  generation: number;
  /** False when the VM record could not be read and `owner` and `generation` are this PC's cache. */
  live: boolean;
  homeWrites: number;
  vmHolds: number;
  transition: { kind: 'handover' | 'reclaim'; phase: string } | null;
  checkpoint: z.infer<typeof GitCheckpointSchema> | null;
  warnings: string[];
}
