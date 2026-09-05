import { z } from 'zod';

export const RelationRouteEffectSchema = z
  .object({
    sourceEpicId: z.string().uuid(),
    targetEpicId: z.string().uuid(),
  })
  .strict();

export const RelationConfirmationSchema = z
  .object({
    acceptedRouteEffect: RelationRouteEffectSchema,
  })
  .strict();

export type RelationConfirmationPayload = z.infer<typeof RelationConfirmationSchema>;
