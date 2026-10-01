import { Injectable, OnModuleInit } from '@nestjs/common';
import { DockerArchiveJournal } from '../../core/controllers/docker-archive-journal';
import { DockerEngineClient } from '../../core/controllers/docker-engine.client';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('HostDockerRecovery');
@Injectable()
export class HostDockerRecoveryService implements OnModuleInit {
  constructor(private readonly journal: DockerArchiveJournal) {}
  async onModuleInit(): Promise<void> {
    const signal = AbortSignal.timeout(3000);
    try {
      if (!(await this.journal.hasPending())) return;
      const result = await this.journal.reconcile(await DockerEngineClient.connect(signal), signal);
      if (result.pending)
        logger.warn({ pending: result.pending }, 'Docker helper cleanup remains pending');
    } catch {
      /* Docker is optional; the next archive request retries durable cleanup. */
    }
  }
}
