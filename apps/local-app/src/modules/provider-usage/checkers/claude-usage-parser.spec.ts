import { parseClaudeUsage, parseResetEpochSeconds } from './claude-usage-parser';

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const epoch = (...utc: [number, number, number, number, number]) => Date.UTC(...utc) / 1000;

const SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 0% used · resets Oct 17, 4:30pm (Europe/Madrid)
Current week (all models): 12% used · resets Oct 23, 12am (Europe/Madrid)
Current week (Fable): 8% used · resets Oct 23, 12am (Europe/Madrid)
`;

describe('parseClaudeUsage', () => {
  it('maps the session, weekly and per-model lines', () => {
    expect(parseClaudeUsage(SAMPLE, NOW)).toEqual({
      kind: 'ok',
      windows: [
        {
          id: '5h',
          label: '5-hour limit',
          kind: '5h',
          usedPercent: 0,
          resetsAt: epoch(2026, 9, 17, 14, 30),
        },
        {
          id: 'weekly',
          label: 'Weekly limit',
          kind: 'weekly',
          usedPercent: 12,
          resetsAt: epoch(2026, 9, 22, 22, 0),
        },
      ],
      extras: [
        {
          id: 'weekly-fable',
          label: 'Weekly · Fable',
          kind: 'weekly',
          usedPercent: 8,
          resetsAt: epoch(2026, 9, 22, 22, 0),
        },
      ],
    });
  });

  it('keeps a window that has not started with resetsAt null', () => {
    const result = parseClaudeUsage('Current session: 0% used\n', NOW);
    expect(result).toMatchObject({
      kind: 'ok',
      windows: [{ id: '5h', usedPercent: 0, resetsAt: null }],
    });
  });

  it('ignores unknown lines and drops a window whose reset time is unreadable', () => {
    const out = [
      'Some new banner line',
      'Current session: 5% used · resets sometime soon',
      'Current week (all models): 12.5% used · resets Oct 23, 12am (Mars/Olympus)',
      'Current week (Opus): 30% used · resets Oct 23, 12am (UTC)',
      'Extra usage: enabled',
    ].join('\n');
    expect(parseClaudeUsage(out, NOW)).toEqual({
      kind: 'ok',
      windows: [],
      extras: [expect.objectContaining({ id: 'weekly-opus', resetsAt: epoch(2026, 9, 23, 0, 0) })],
    });
  });

  it('strips terminal escape codes', () => {
    const out = '\u001b[1mCurrent session: 7% used · resets Oct 17, 4:30pm (UTC)\u001b[0m';
    expect(parseClaudeUsage(out, NOW)).toMatchObject({
      kind: 'ok',
      windows: [{ id: '5h', usedPercent: 7, resetsAt: epoch(2026, 9, 17, 16, 30) }],
    });
  });

  it('reports an API-key account as not-available', () => {
    expect(
      parseClaudeUsage('Total cost:            $0.0000\nTotal duration (API):  0s\n', NOW),
    ).toEqual({
      kind: 'not-available',
    });
  });

  it.each(['', 'garbage', 'You are currently using your subscription to power Claude Code\n'])(
    'reports unrecognized output %j as an error',
    (out) => {
      expect(parseClaudeUsage(out, NOW)).toEqual({ kind: 'error' });
    },
  );
});

describe('parseResetEpochSeconds', () => {
  it('resolves the zone offset of the date, not of today', () => {
    // CEST (UTC+2) before the October change, CET (UTC+1) after it.
    expect(parseResetEpochSeconds('Oct 23, 12am (Europe/Madrid)', NOW)).toBe(
      epoch(2026, 9, 22, 22, 0),
    );
    expect(parseResetEpochSeconds('Dec 5, 9:30am (Europe/Madrid)', NOW)).toBe(
      epoch(2026, 11, 5, 8, 30),
    );
  });

  it('reads 12am as midnight and 12pm as noon', () => {
    expect(parseResetEpochSeconds('Oct 18, 12am (UTC)', NOW)).toBe(epoch(2026, 9, 18, 0, 0));
    expect(parseResetEpochSeconds('Oct 18, 12pm (UTC)', NOW)).toBe(epoch(2026, 9, 18, 12, 0));
  });

  it('rolls a date that already passed into the next year', () => {
    const afterReset = Date.UTC(2026, 10, 1, 12, 0, 0);
    // CEST again in 2027: the change is on Oct 31.
    expect(parseResetEpochSeconds('Oct 23, 12am (Europe/Madrid)', afterReset)).toBe(
      epoch(2027, 9, 22, 22, 0),
    );
  });

  it('uses the year of the zone, not of UTC, around New Year', () => {
    const now = Date.UTC(2026, 11, 31, 23, 30, 0);
    // Already 2027-01-01 00:30 in Madrid.
    expect(parseResetEpochSeconds('Jan 1, 1am (Europe/Madrid)', now)).toBe(epoch(2027, 0, 1, 0, 0));
  });

  it('finds the next leap year for Feb 29', () => {
    expect(parseResetEpochSeconds('Feb 29, 12am (UTC)', NOW)).toBe(epoch(2028, 1, 29, 0, 0));
  });

  it.each([
    'Oct 32, 12am (UTC)',
    'Foo 3, 12am (UTC)',
    'Oct 3, 13am (UTC)',
    'Oct 3, 4:75pm (UTC)',
    'Oct 3, 4pm',
  ])('rejects %j', (text) => {
    expect(parseResetEpochSeconds(text, NOW)).toBeNull();
  });
});
