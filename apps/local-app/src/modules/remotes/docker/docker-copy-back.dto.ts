import { z } from 'zod';
import type { DockerDataRepresentationGroup, DockerDataState, DockerPlan } from './docker-plan.dto';

export const DockerSyncStateRequestSchema = z.object({ remoteId: z.string().uuid() }).strict();

/** What to do with a data group that changed on both sides, or whose state is unknown. */
export const DockerCopyBackChoiceSchema = z.enum(['copy-home', 'keep-home']);
export type DockerCopyBackChoice = z.infer<typeof DockerCopyBackChoiceSchema>;

/** Disconnect's "Copy Docker data back to this PC", with the choices keyed by group key. */
export const DockerCopyBackRequestSchema = z
  .object({
    choices: z
      .record(z.string().regex(/^[0-9a-f]{16}$/), DockerCopyBackChoiceSchema)
      .refine((choices) => Object.keys(choices).length <= 1000)
      .default({}),
  })
  .strict();
export type DockerCopyBackRequest = z.infer<typeof DockerCopyBackRequestSchema>;

/** Why Disconnect leaves a bind folder out of the copy: file sync still carries it. */
export const FILE_SYNC_SKIP_REASON = 'still synced by file sync' as const;

export const FOLLOWS_USER_SKIP_REASON =
  'Data whose owners follow the developer user stays on the VM because its recorded owner representation is unknown. Verify or replace the data through Connect before copying it home.';

export interface DockerSyncGroup {
  /** Stable for the same volumes and folders; the key of a choice. */
  key: string;
  itemNames: string[];
  volumes: string[];
  bindPaths: string[];
  state: DockerDataState;
  dataRepresentations?: DockerDataRepresentationGroup[];
  createdOnVm?: boolean;
  skipReason?: string;
  /** Bind targets whose whole subtree is not excluded on both file-sync peers. */
  syncedByFileSync?: string[];
  /** both-changed and unknown: the Disconnect needs a choice to copy or keep. */
  needsChoice: boolean;
}

/** `POST /api/projects/:id/docker/sync-state`: the change check of the project's imported data. */
export interface DockerSyncState {
  availability: DockerPlan['availability'];
  /** A Connect imported Docker data of this project to this VM. */
  imported: boolean;
  groups: DockerSyncGroup[];
}

/** `details.dockerCopyBackResult` of a finished Disconnect: group labels per outcome. */
export interface DockerCopyBackResult {
  copied: string[];
  kept: string[];
  skipped: string[];
  alreadyTargetEntries?: number;
}
