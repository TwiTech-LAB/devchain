import { z } from 'zod';

export const HostProjectIdSchema = z.string().trim().min(1).max(128);

export const HostImportQuerySchema = z
  .object({
    /** Re-applies over an existing project instead of refusing it with 409. */
    mode: z.literal('resnapshot').optional(),
  })
  .strict();

export const HostReplicaQuerySchema = z
  .object({
    /** `detach` hands the project back; `attach` is the re-snapshot a mirror takes after a failed apply. */
    scope: z.enum(['attach', 'detach']),
  })
  .strict();

export const HostChangesQuerySchema = z
  .object({
    since: z.string().datetime({ offset: true }).optional(),
    full: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .strict();

export type HostChangesQuery = z.infer<typeof HostChangesQuerySchema>;

export const HostIdempotencyKeySchema = z.string().min(1).max(256);
