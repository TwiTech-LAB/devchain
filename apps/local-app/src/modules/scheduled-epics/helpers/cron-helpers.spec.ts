import { validateCronExpression, getNextRunAt } from './cron-helpers';

describe('validateCronExpression', () => {
  it('accepts standard 5-part cron expressions', () => {
    expect(validateCronExpression('* * * * *')).toEqual({ valid: true });
    expect(validateCronExpression('0 9 * * 1-5')).toEqual({ valid: true });
    expect(validateCronExpression('30 8 1 * *')).toEqual({ valid: true });
  });

  it('rejects an obviously malformed expression', () => {
    const result = validateCronExpression('not-a-cron');
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toBeTruthy();
  });
});

describe('getNextRunAt', () => {
  it('returns a date after the supplied "after" argument', () => {
    const after = new Date('2025-01-01T00:00:00Z');
    const next = getNextRunAt('0 9 * * *', 'UTC', after);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(after.getTime());
  });

  it('respects timezone for next-run calculation', () => {
    const after = new Date('2025-01-01T00:00:00Z');
    const utcNext = getNextRunAt('0 9 * * *', 'UTC', after);
    const nyNext = getNextRunAt('0 9 * * *', 'America/New_York', after);
    expect(utcNext).not.toBeNull();
    expect(nyNext).not.toBeNull();
    // 9 AM UTC vs 9 AM ET (UTC-5) — ET result is 5 hours later in UTC
    expect(nyNext!.getTime()).toBeGreaterThan(utcNext!.getTime());
  });
});
