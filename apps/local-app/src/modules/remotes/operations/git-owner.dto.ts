import { z } from 'zod';
import type { GitGuardRemoveResult } from '../../file-sync/git-guard.dto';
import type { GitOwner } from '../git-owner.store';
import type { RemoteOperation, RemoteOperationStepError } from '../../storage/models/domain.models';

export const GitOwnerProjectSchema = z
  .object({
    projectId: z.string().min(1),
    owner: z.enum(['home', 'vm']),
    force: z.boolean().default(false),
  })
  .strict();
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

export interface GitSwitchAgent {
  agentName: string;
  state: 'busy' | 'starting' | 'unknown';
  since: string;
}

export interface GitOwnerDetails {
  owner: GitOwner;
  force: boolean;
  unknownAgents?: GitSwitchAgent[];
  /** Cleanup obligations until the corresponding install steps complete. */
  vmGuardInstalled?: boolean;
  pcGuardInstalled?: boolean;
  vmGuardWarning?: string | null;
  guardWarning?: string | null;
  pcGuardRemove?: GitGuardRemoveResult;
  vmGuardRemove?: GitGuardRemoveResult;
}

export type GitOwnerStartResult =
  | RemoteOperation
  | {
      owner: GitOwner;
      changed: false;
      cancelledOperationId?: string;
    };

export interface GitOwnerStatus {
  connected: boolean;
  remoteId: string | null;
  remoteName: string | null;
  owner: GitOwner;
  open: {
    operationId: string;
    owner: GitOwner;
    force: boolean;
    state: 'running' | 'failed';
    step: string | null;
    error: RemoteOperationStepError | null;
  } | null;
}

export function gitOwnerCommand(owner: GitOwner, force: boolean): string {
  return owner === 'home' ? `devchain git take${force ? ' --force' : ''}` : 'devchain git return';
}
