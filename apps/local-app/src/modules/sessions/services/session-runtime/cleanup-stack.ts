import { createLogger } from '../../../../common/logging/logger';

const logger = createLogger('CleanupStack');

export type Compensator = {
  phase: string;
  rollback: () => Promise<void>;
};

export class CleanupStack {
  private readonly stack: Compensator[] = [];

  push(phase: string, rollback: () => Promise<void>): void {
    this.stack.push({ phase, rollback });
  }

  async rollback(context: { sessionId?: string }): Promise<void> {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const compensator = this.stack[i];
      try {
        await compensator.rollback();
        logger.info(
          { phase: compensator.phase, sessionId: context.sessionId },
          'Compensator executed successfully',
        );
      } catch (error) {
        logger.error(
          { phase: compensator.phase, sessionId: context.sessionId, error },
          'Compensator failed during rollback',
        );
      }
    }
  }
}
