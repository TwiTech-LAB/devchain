import { z } from 'zod';

/**
 * A replica was applied to this instance's copy of the project. Mirror writes
 * publish no `epic.*` events; subscribers read current rows for these IDs.
 */
export const remoteProjectSyncedEvent = {
  name: 'remote.project.synced',
  schema: z
    .object({
      projectId: z.string().min(1),
      workspaceId: z.string().min(1),
      /** Remote the replica came from; null when this instance is the host receiving an attach. */
      remoteId: z.string().min(1).nullable(),
      changedEpicIds: z.array(z.string().min(1)),
      deletedEpicIds: z.array(z.string().min(1)),
      /** Host-side ISO timestamp the replica reflects; null when not tracked. */
      cursor: z.string().min(1).nullable(),
    })
    .strict(),
} as const;

export type RemoteProjectSyncedEventPayload = z.infer<typeof remoteProjectSyncedEvent.schema>;
