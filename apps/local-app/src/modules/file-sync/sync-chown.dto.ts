import { z } from 'zod';
import { SyncRelativePathSchema, SyncPathOwnerSchema } from './sync-path-inspection.dto';

/** The most paths one Give to request (and one recorded chown action) carries. */
export const SYNC_CHOWN_PATHS_MAX = 200;
export const SyncChownItemSchema = z
  .object({ path: SyncRelativePathSchema, mode: z.enum(['automatic', 'give']) })
  .strict();
export const SyncChownRequestSchema = z
  .object({
    root: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (value) =>
          value.startsWith('/') &&
          !/[\x00\r\n]/.test(value) &&
          value.split('/').every((part) => part !== '..' && part !== '.'),
        'Expected an absolute project root without traversal',
      ),
    items: z.array(SyncChownItemSchema),
  })
  .strict();
export const SyncChownResultSchema = z.object({
  user: SyncPathOwnerSchema.nullable(),
  items: z.array(
    z.object({
      path: SyncRelativePathSchema,
      state: z.enum(['repaired', 'unchanged', 'refused', 'unsupported']),
      paths: z.array(SyncRelativePathSchema),
      reason: z.string().optional(),
    }),
  ),
});
export const GiveOwnershipRequestSchema = z
  .object({ paths: z.array(SyncRelativePathSchema).min(1).max(SYNC_CHOWN_PATHS_MAX) })
  .strict();
export type SyncChownRequest = z.infer<typeof SyncChownRequestSchema>;
export type SyncChownResult = z.infer<typeof SyncChownResultSchema>;

/** The answer when the VM cannot repair owners: an older host or a missing helper. */
export function unsupportedChown(
  user: SyncChownResult['user'],
  items: readonly { path: string }[],
): SyncChownResult {
  return {
    user,
    items: items.map(({ path }) => ({
      path,
      state: 'unsupported',
      paths: [],
      reason: 'The VM ownership helper is unavailable. Update the VM or use the copy command.',
    })),
  };
}
