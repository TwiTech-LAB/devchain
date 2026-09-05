import { canonicalizeEpicTimeZone, resolveLocalDayInterval } from './epic-time-local-day';

// Layer: backend unit. The helper is pure time-zone math shared with the
// browser; Intl against real tzdata is the cheapest reliable oracle.
describe('epic-time local-day helper', () => {
  describe('canonicalizeEpicTimeZone', () => {
    it('canonicalizes UTC aliases to one consistent value', () => {
      for (const alias of ['UTC', 'utc', 'Etc/UTC', 'GMT', 'Etc/GMT', 'Zulu', 'Etc/Zulu']) {
        expect(canonicalizeEpicTimeZone(alias)).toBe('UTC');
      }
    });

    it('canonicalizes named zones case-insensitively and resolves links', () => {
      expect(canonicalizeEpicTimeZone('america/new_york')).toBe('America/New_York');
      expect(canonicalizeEpicTimeZone('America/Argentina/Buenos_Aires')).toBe(
        'America/Buenos_Aires',
      );
    });

    it('rejects fixed offsets, empty, oversized, and unknown zones', () => {
      expect(canonicalizeEpicTimeZone('+01:00')).toBeNull();
      expect(canonicalizeEpicTimeZone('-0530')).toBeNull();
      expect(canonicalizeEpicTimeZone('')).toBeNull();
      expect(canonicalizeEpicTimeZone('   ')).toBeNull();
      expect(canonicalizeEpicTimeZone('a'.repeat(129))).toBeNull();
      expect(canonicalizeEpicTimeZone('Not/A_Zone')).toBeNull();
      expect(canonicalizeEpicTimeZone('Z')).toBeNull();
    });
  });

  describe('resolveLocalDayInterval', () => {
    it('returns exact instants for an ordinary UTC day', () => {
      expect(resolveLocalDayInterval('2026-01-15', 'UTC')).toEqual({
        activityDate: '2026-01-15',
        startUtcMs: Date.UTC(2026, 0, 15),
        nextStartUtcMs: Date.UTC(2026, 0, 16),
        durationMs: 24 * 3_600_000,
      });
    });

    it('returns a 23-hour interval on a spring-forward day', () => {
      expect(resolveLocalDayInterval('2026-03-08', 'America/New_York')).toEqual({
        activityDate: '2026-03-08',
        startUtcMs: Date.UTC(2026, 2, 8, 5),
        nextStartUtcMs: Date.UTC(2026, 2, 9, 4),
        durationMs: 23 * 3_600_000,
      });
    });

    it('returns a 25-hour interval on a fall-back day', () => {
      expect(resolveLocalDayInterval('2026-11-01', 'America/New_York')).toEqual({
        activityDate: '2026-11-01',
        startUtcMs: Date.UTC(2026, 10, 1, 4),
        nextStartUtcMs: Date.UTC(2026, 10, 2, 5),
        durationMs: 25 * 3_600_000,
      });
    });

    it('returns a 24.5-hour interval on a Lord Howe fall-back day', () => {
      expect(resolveLocalDayInterval('2026-04-05', 'Australia/Lord_Howe')).toEqual({
        activityDate: '2026-04-05',
        startUtcMs: Date.UTC(2026, 3, 4, 13),
        nextStartUtcMs: Date.UTC(2026, 3, 5, 13, 30),
        durationMs: 24.5 * 3_600_000,
      });
    });

    it('returns a 23.5-hour interval on a Lord Howe spring-forward day', () => {
      expect(resolveLocalDayInterval('2026-10-04', 'Australia/Lord_Howe')).toEqual({
        activityDate: '2026-10-04',
        startUtcMs: Date.UTC(2026, 9, 3, 13, 30),
        nextStartUtcMs: Date.UTC(2026, 9, 4, 13),
        durationMs: 23.5 * 3_600_000,
      });
    });

    it('starts a midnight-skipping DST day at its first existing local time', () => {
      // Havana jumps 00:00 -> 01:00 on 2026-03-08, so local midnight does
      // not exist and the day starts at 01:00 local (05:00 UTC).
      const interval = resolveLocalDayInterval('2026-03-08', 'America/Havana');
      expect(interval.startUtcMs).toBe(Date.UTC(2026, 2, 8, 5));
      expect(interval.durationMs).toBe(23 * 3_600_000);
    });

    it('rolls the next-day start across month and year boundaries', () => {
      expect(resolveLocalDayInterval('2026-12-31', 'UTC').nextStartUtcMs).toBe(
        Date.UTC(2027, 0, 1),
      );
      expect(resolveLocalDayInterval('2026-02-28', 'UTC').nextStartUtcMs).toBe(
        Date.UTC(2026, 2, 1),
      );
    });

    it('rejects malformed or non-calendar dates and invalid zones', () => {
      expect(() => resolveLocalDayInterval('2026-2-8', 'UTC')).toThrow();
      expect(() => resolveLocalDayInterval('2026-02-30', 'UTC')).toThrow();
      expect(() => resolveLocalDayInterval('not-a-date', 'UTC')).toThrow();
      expect(() => resolveLocalDayInterval('2026-01-15', 'Not/A_Zone')).toThrow();
    });
  });
});
