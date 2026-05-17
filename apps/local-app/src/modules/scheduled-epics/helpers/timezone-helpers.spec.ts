import { validateTimezone } from './timezone-helpers';

describe('validateTimezone', () => {
  it('accepts UTC', () => {
    expect(validateTimezone('UTC')).toEqual({ valid: true });
  });

  it('accepts standard IANA timezone identifiers', () => {
    expect(validateTimezone('America/New_York')).toEqual({ valid: true });
    expect(validateTimezone('Europe/London')).toEqual({ valid: true });
    expect(validateTimezone('Asia/Tokyo')).toEqual({ valid: true });
  });

  it('rejects an empty string', () => {
    const result = validateTimezone('');
    expect(result.valid).toBe(false);
  });

  it('rejects a whitespace-only string', () => {
    const result = validateTimezone('   ');
    expect(result.valid).toBe(false);
  });

  it('rejects unknown timezone identifiers', () => {
    const result = validateTimezone('Mars/Olympus');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('Mars/Olympus');
    }
  });

  it('rejects plausible but invalid zone strings', () => {
    const result = validateTimezone('America/Fake_City');
    expect(result.valid).toBe(false);
  });
});
