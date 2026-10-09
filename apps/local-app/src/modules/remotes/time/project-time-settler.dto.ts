import { z } from 'zod';

export const ProjectTimeSettlementSchema = z.object({
  /** `forced`: the wait hit its bound and the remaining batches were finalized or cancelled. */
  outcome: z.enum(['settled', 'forced']),
  waitedMs: z.number().int().nonnegative(),
  closedSegments: z.number().int().nonnegative(),
  finalizedBatchIds: z.array(z.string()),
  cancelledBatchIds: z.array(z.string()),
});

export type ProjectTimeSettlement = z.infer<typeof ProjectTimeSettlementSchema>;
