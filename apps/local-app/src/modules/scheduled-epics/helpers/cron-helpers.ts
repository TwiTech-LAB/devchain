import { Cron } from 'croner';

export type CronValidationResult = { valid: true } | { valid: false; reason: string };

export function validateCronExpression(expression: string): CronValidationResult {
  try {
    new Cron(expression, { paused: true });
    return { valid: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Invalid cron expression';
    return { valid: false, reason };
  }
}

export function getNextRunAt(expression: string, timezone: string, after?: Date): Date | null {
  const cron = new Cron(expression, { timezone, paused: true });
  return cron.nextRun(after ?? new Date());
}
