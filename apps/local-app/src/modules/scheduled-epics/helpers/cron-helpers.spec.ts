import { validateCronExpression, getNextRunAt } from './cron-helpers';

describe('validateCronExpression', () => {
  it('accepts standard 5-part cron expressions', () => {
    expect(validateCronExpression('* * * * *')).toEqual({ valid: true });
    expect(validateCronExpression('0 9 * * 1-5')).toEqual({ valid: true });
    expect(validateCronExpression('30 8 1 * *')).toEqual({ valid: true });
  });

  it('accepts 6-part cron with seconds', () => {
    expect(validateCronExpression('0 0 * * * *')).toEqual({ valid: true });
  });

  it('rejects an empty string', () => {
    const result = validateCronExpression('');
    expect(result.valid).toBe(false);
  });

  it('rejects an obviously malformed expression', () => {
    const result = validateCronExpression('not-a-cron');
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toBeTruthy();
  });

  it('rejects out-of-range values', () => {
    const result = validateCronExpression('99 99 99 99 99');
    expect(result.valid).toBe(false);
  });

  it('returns a non-empty reason on failure', () => {
    const result = validateCronExpression('bad');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('getNextRunAt', () => {
  it('returns a Date for a valid expression and timezone', () => {
    const next = getNextRunAt('* * * * *', 'UTC');
    expect(next).toBeInstanceOf(Date);
  });

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
