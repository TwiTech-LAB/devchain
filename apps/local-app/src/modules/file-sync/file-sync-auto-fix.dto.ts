import { z } from 'zod';
import { IgnorePatternsSchema } from './file-sync.dto';
import { SYNC_CHOWN_PATHS_MAX } from './sync-chown.dto';

/** How many automatic actions a project keeps; older ones drop off. */
export const FILE_SYNC_AUTO_FIX_ACTIONS_MAX = 10;

const action = { at: z.string().datetime(), side: z.enum(['home', 'vm']) };
export const FileSyncAutoFixActionSchema = z.discriminatedUnion('kind', [
  z.object({ ...action, kind: z.literal('exclude'), patterns: IgnorePatternsSchema }),
  z.object({
    ...action,
    kind: z.literal('chown'),
    paths: z.array(z.string()).max(SYNC_CHOWN_PATHS_MAX),
  }),
]);
export type FileSyncAutoFixAction = z.infer<typeof FileSyncAutoFixActionSchema>;
export const FileSyncAutoFixSchema = z.object({
  enabled: z.boolean(),
  actions: z.array(FileSyncAutoFixActionSchema).max(FILE_SYNC_AUTO_FIX_ACTIONS_MAX),
});
export type FileSyncAutoFix = z.infer<typeof FileSyncAutoFixSchema>;
export const AutoFixBodySchema = z.object({ enabled: z.boolean() }).strict();
