import { Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { CloudSessionManagerService } from './cloud-session-manager.service';

const logger = createLogger('RefreshGate');

export type RefreshOutcome = 'success' | 'transient_failure' | 'permanent_failure';

@Injectable()
export class RefreshGateService {
  private refreshPromise: Promise<RefreshOutcome> | null = null;

  constructor(private readonly cloudSession: CloudSessionManagerService) {}

  async attemptRefresh(): Promise<RefreshOutcome> {
    if (this.refreshPromise) {
      logger.debug('Joining existing refresh flight');
      return this.refreshPromise;
    }

    this.refreshPromise = this.doRefresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefresh(): Promise<RefreshOutcome> {
    try {
      await this.cloudSession.refreshAccessToken();

      if (this.cloudSession.getAccessToken()) {
        logger.info('Single-flight refresh succeeded');
        return 'success';
      }

      logger.warn('Refresh completed but no access token — permanent failure');
      return 'permanent_failure';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (
        message.includes('invalid') ||
        message.includes('revoked') ||
        message.includes('banned')
      ) {
        logger.warn({ error }, 'Permanent refresh failure');
        return 'permanent_failure';
      }

      logger.warn({ error }, 'Transient refresh failure');
      return 'transient_failure';
    }
  }
}
