import {
  describeCron,
  formatNextRun,
  type CronPreset,
} from './schedules';

const mockPresets: CronPreset[] = [
  { label: 'Every hour', cronExpression: '0 * * * *', description: 'Every hour' },
  { label: 'Daily at midnight', cronExpression: '0 0 * * *', description: 'Daily' },
  { label: 'Weekly (Monday)', cronExpression: '0 0 * * 1', description: 'Weekly' },
];

describe('schedules lib', () => {
  describe('describeCron', () => {
    it('returns preset label for known expressions', () => {
      expect(describeCron('0 * * * *', mockPresets)).toBe('Every hour');
      expect(describeCron('0 0 * * *', mockPresets)).toBe('Daily at midnight');
    });

    it('returns raw expression for unknown cron', () => {
      expect(describeCron('30 14 * * 5', mockPresets)).toBe('30 14 * * 5');
    });

    it('returns raw expression when presets is empty', () => {
      expect(describeCron('0 * * * *', [])).toBe('0 * * * *');
    });
  });

  describe('formatNextRun', () => {
    it('returns "Not scheduled" for null', () => {
      expect(formatNextRun(null)).toBe('Not scheduled');
    });

    it('returns "Overdue" for past dates', () => {
      expect(formatNextRun('2020-01-01T00:00:00.000Z')).toBe('Overdue');
    });

    it('returns relative time for near future', () => {
      const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const result = formatNextRun(fiveMinutesFromNow);
      expect(result).toContain('minutes');
    });

    it('returns formatted date for far future', () => {
      const twoDaysFromNow = new Date(Date.now() + 2 * 86400000).toISOString();
      const result = formatNextRun(twoDaysFromNow);
      expect(result).toBeTruthy();
      expect(result).not.toBe('Overdue');
      expect(result).not.toBe('Not scheduled');
    });

    it('returns sub-minute message for very near future', () => {
      const thirtySecondsFromNow = new Date(Date.now() + 30000).toISOString();
      const result = formatNextRun(thirtySecondsFromNow);
      expect(result).toBe('In less than a minute');
    });
  });
});
