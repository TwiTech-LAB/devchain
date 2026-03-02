import {
  formatTokensCompact,
  formatTokensSmart,
  formatTokensDetailed,
  formatCost,
  formatDuration,
  formatContextPercent,
  formatTimestamp,
  truncateText,
} from './session-reader-formatters';

describe('session-reader-formatters', () => {
  // -------------------------------------------------------------------------
  // formatTokensCompact
  // -------------------------------------------------------------------------

  describe('formatTokensCompact', () => {
    it('returns raw number below 1k', () => {
      expect(formatTokensCompact(0)).toBe('0');
      expect(formatTokensCompact(500)).toBe('500');
      expect(formatTokensCompact(999)).toBe('999');
    });

    it('returns one decimal for 1k–10k', () => {
      expect(formatTokensCompact(1000)).toBe('1.0k');
      expect(formatTokensCompact(1500)).toBe('1.5k');
      expect(formatTokensCompact(9999)).toBe('10.0k');
    });

    it('returns rounded k for 10k–1M', () => {
      expect(formatTokensCompact(10000)).toBe('10k');
      expect(formatTokensCompact(150000)).toBe('150k');
      expect(formatTokensCompact(999999)).toBe('1000k');
    });

    it('returns M for 1M+', () => {
      expect(formatTokensCompact(1_000_000)).toBe('1.0M');
      expect(formatTokensCompact(2_300_000)).toBe('2.3M');
    });
  });

  // -------------------------------------------------------------------------
  // formatTokensSmart
  // -------------------------------------------------------------------------

  describe('formatTokensSmart', () => {
    it('uses commas below 10k', () => {
      expect(formatTokensSmart(500)).toBe('500');
      expect(formatTokensSmart(1500)).toBe('1,500');
      expect(formatTokensSmart(9999)).toBe('9,999');
    });

    it('uses k for 10k–1M', () => {
      expect(formatTokensSmart(10000)).toBe('10k');
      expect(formatTokensSmart(150000)).toBe('150k');
    });

    it('uses M for 1M+', () => {
      expect(formatTokensSmart(2_300_000)).toBe('2.3M');
    });
  });

  // -------------------------------------------------------------------------
  // formatTokensDetailed
  // -------------------------------------------------------------------------

  describe('formatTokensDetailed', () => {
    it('returns comma-separated number', () => {
      expect(formatTokensDetailed(500)).toBe('500');
      expect(formatTokensDetailed(1500)).toBe('1,500');
      expect(formatTokensDetailed(1_000_000)).toBe('1,000,000');
    });
  });

  // -------------------------------------------------------------------------
  // formatCost
  // -------------------------------------------------------------------------

  describe('formatCost', () => {
    it('returns $0 for zero', () => {
      expect(formatCost(0)).toBe('$0');
    });

    it('uses 2 decimal places for >= $0.01', () => {
      expect(formatCost(1.23)).toBe('$1.23');
      expect(formatCost(0.04)).toBe('$0.04');
      expect(formatCost(0.01)).toBe('$0.01');
    });

    it('uses 4 decimal places for < $0.01', () => {
      expect(formatCost(0.0012)).toBe('$0.0012');
      expect(formatCost(0.009)).toBe('$0.0090');
    });
  });

  // -------------------------------------------------------------------------
  // formatDuration
  // -------------------------------------------------------------------------

  describe('formatDuration', () => {
    it('returns ms for < 1s', () => {
      expect(formatDuration(0)).toBe('0ms');
      expect(formatDuration(500)).toBe('500ms');
      expect(formatDuration(999)).toBe('999ms');
    });

    it('returns seconds for < 1m', () => {
      expect(formatDuration(1000)).toBe('1.0s');
      expect(formatDuration(2500)).toBe('2.5s');
      expect(formatDuration(59999)).toBe('60.0s');
    });

    it('returns m s for < 1h', () => {
      expect(formatDuration(60000)).toBe('1m 0s');
      expect(formatDuration(150000)).toBe('2m 30s');
      expect(formatDuration(3599999)).toBe('59m 60s');
    });

    it('returns h m for >= 1h', () => {
      expect(formatDuration(3_600_000)).toBe('1h 0m');
      expect(formatDuration(4_500_000)).toBe('1h 15m');
      expect(formatDuration(7_260_000)).toBe('2h 1m');
    });
  });

  // -------------------------------------------------------------------------
  // formatContextPercent
  // -------------------------------------------------------------------------

  describe('formatContextPercent', () => {
    it('returns dash for zero window', () => {
      expect(formatContextPercent(100, 0)).toBe('—');
    });

    it('returns <1% for tiny usage', () => {
      expect(formatContextPercent(1, 200_000)).toBe('<1%');
    });

    it('returns rounded percentage', () => {
      expect(formatContextPercent(40_000, 200_000)).toBe('20%');
      expect(formatContextPercent(100_000, 200_000)).toBe('50%');
      expect(formatContextPercent(200_000, 200_000)).toBe('100%');
    });
  });

  // -------------------------------------------------------------------------
  // formatTimestamp
  // -------------------------------------------------------------------------

  describe('formatTimestamp', () => {
    it('returns HH:MM:SS format', () => {
      const result = formatTimestamp('2026-02-24T12:30:45.000Z');
      // The exact format depends on locale, but should contain time parts
      expect(result).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    });
  });

  // -------------------------------------------------------------------------
  // truncateText
  // -------------------------------------------------------------------------

  describe('truncateText', () => {
    it('returns text unchanged if within limit', () => {
      expect(truncateText('short', 10)).toBe('short');
    });

    it('truncates with ellipsis when over limit', () => {
      expect(truncateText('hello world', 5)).toBe('hello…');
    });

    it('returns exact length text unchanged', () => {
      expect(truncateText('exact', 5)).toBe('exact');
    });
  });
});
