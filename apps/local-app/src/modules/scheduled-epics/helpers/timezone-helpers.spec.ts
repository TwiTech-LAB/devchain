import { validateTimezone } from './timezone-helpers';

describe('validateTimezone', () => {
  it('accepts UTC', () => {
    expect(validateTimezone('UTC')).toEqual({ valid: true });
  });

  it.each(['', '   '])('rejects empty zone %j', (zone) => {
    expect(validateTimezone(zone).valid).toBe(false);
  });

  it('rejects unknown timezone identifiers', () => {
    const result = validateTimezone('Mars/Olympus');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('Mars/Olympus');
    }
  });
});
