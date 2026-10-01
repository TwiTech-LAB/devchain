import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { getEnvConfig } from '../../../common/config/env.config';
import { createLogger } from '../../../common/logging/logger';
import { EPIC_TIME_DELIVERY_KEY } from '../../epic-time/services/agent-time-accounting.service';
import { EpicTimeStore } from '../../epic-time/services/epic-time.store';

const logger = createLogger('ProjectTimeSettler');

const SETTLE_POLL_MS = 100;

export const ProjectTimeSettlementSchema = z.object({
  /** `forced`: the wait hit its bound and the remaining batches were finalized or cancelled. */
  outcome: z.enum(['settled', 'forced']),
  waitedMs: z.number().int().nonnegative(),
  closedSegments: z.number().int().nonnegative(),
  finalizedBatchIds: z.array(z.string()),
  cancelledBatchIds: z.array(z.string()),
});

export type ProjectTimeSettlement = z.infer<typeof ProjectTimeSettlementSchema>;

/**
 * Brings one project's agent time to rest before another instance takes it
 * over: no open segment and no team batch is left, so the copy carries only
 * settled segments and no lane is lost or counted twice. Runs on the instance
 * that owns the project's accounting, after its sessions were stopped.
 */
@Injectable()
export class ProjectTimeSettler {
  private readonly timeoutMs: number;

  constructor(private readonly store: EpicTimeStore) {
    this.timeoutMs = getEnvConfig().REMOTES_TIME_SETTLE_TIMEOUT_MS;
  }

  /**
   * Waits up to `REMOTES_TIME_SETTLE_TIMEOUT_MS` for team batches to finalize
   * through their normal barrier, then finalizes or cancels what is left.
   */
  async settle(projectId: string): Promise<ProjectTimeSettlement> {
    const settlement: ProjectTimeSettlement = {
      outcome: 'settled',
      waitedMs: 0,
      closedSegments: 0,
      finalizedBatchIds: [],
      cancelledBatchIds: [],
    };
    const { trackingStartedAt, idleTimeoutMs } = this.store.readActivationSettings();
    // Accounting never ran on this instance: there is nothing to settle.
    if (!trackingStartedAt) return settlement;

    const startedAt = Date.now();
    for (;;) {
      const force = Date.now() - startedAt >= this.timeoutMs;
      const pass = await this.store.settleProjectTime({
        projectId,
        trackingStartedAt,
        idleTimeoutMs,
        deliveryKey: EPIC_TIME_DELIVERY_KEY,
        force,
      });
      settlement.closedSegments += pass.closedSegments;
      settlement.finalizedBatchIds.push(...pass.finalizedBatchIds);
      settlement.cancelledBatchIds.push(...pass.cancelledBatchIds);
      settlement.waitedMs = Date.now() - startedAt;
      if (pass.openSegments === 0 && pass.openBatches === 0) {
        if (force) {
          settlement.outcome = 'forced';
          logger.warn(
            {
              projectId,
              finalized: settlement.finalizedBatchIds.length,
              cancelled: settlement.cancelledBatchIds.length,
            },
            'Team batches did not settle in time; finalized or cancelled them',
          );
        }
        return settlement;
      }
      if (force) {
        throw new Error(
          `Project time did not settle: ${pass.openSegments} open segments, ${pass.openBatches} team batches left.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    }
  }
}
