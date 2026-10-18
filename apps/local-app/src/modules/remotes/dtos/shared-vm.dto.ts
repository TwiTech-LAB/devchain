import { z } from 'zod';

/** The refusal code of a Reset or Destroy while other users have connected projects. */
export const SHARED_VM_GUARD_CODE = 'VM_SHARED_PROJECTS_CONNECTED';

/** Reset and Destroy delete the VM, so the shared-VM guard covers them. */
export function isSharedVmGuardedKind(kind: string): boolean {
  return kind === 'reset_vm' || kind === 'destroy_vm';
}

export const SharedVmProjectIdsSchema = z.union([
  z.array(z.string().min(1).max(128)),
  z.literal('unknown'),
]);
export const SharedVmInstanceSchema = z
  .object({
    user: z.string().min(1),
    port: z.number().int().min(1024).max(65535),
    version: z.string().nullable(),
    connectedCount: z.union([z.number().int().nonnegative(), z.literal('unknown')]),
    connectedProjectIds: SharedVmProjectIdsSchema.optional().default('unknown'),
  })
  .superRefine((instance, context) => {
    if (
      typeof instance.connectedCount === 'number' &&
      Array.isArray(instance.connectedProjectIds) &&
      (new Set(instance.connectedProjectIds).size !== instance.connectedCount ||
        instance.connectedProjectIds.length !== instance.connectedCount)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Connected projects do not match the count.',
      });
    }
  });
export const SharedVmRosterSchema = z.object({ instances: z.array(SharedVmInstanceSchema) });
export const SharedVmOccupancySchema = z.object({
  unavailable: z.boolean(),
  instances: z.array(SharedVmInstanceSchema),
});
export const SharedVmSavedRosterSchema = z.object({
  roster: SharedVmRosterSchema,
  ownUser: z.string(),
  at: z.string(),
  vmIdentity: z.string().nullable(),
});
export const SharedVmGuardContextSchema = z.object({
  occupancy: SharedVmOccupancySchema,
  lastRoster: SharedVmSavedRosterSchema.nullable(),
});
export type SharedVmRoster = z.infer<typeof SharedVmRosterSchema>;
export type SharedVmOccupancy = z.infer<typeof SharedVmOccupancySchema>;
export type SharedVmSavedRoster = z.infer<typeof SharedVmSavedRosterSchema>;
export type SharedVmGuardContext = z.infer<typeof SharedVmGuardContextSchema>;
export const SharedVmRetryConfirmationSchema = z
  .object({
    force: z.boolean().optional(),
    forceOccupied: z.boolean().optional(),
    confirmedOccupancy: SharedVmOccupancySchema.optional(),
  })
  .strict();
export type SharedVmRetryConfirmation = z.infer<typeof SharedVmRetryConfirmationSchema>;

export function sharedVmOccupied(occupancy: SharedVmOccupancy): boolean {
  return (
    occupancy.unavailable ||
    occupancy.instances.some(
      ({ connectedCount, connectedProjectIds }) =>
        connectedCount === 'unknown' || connectedCount > 0 || connectedProjectIds === 'unknown',
    )
  );
}
