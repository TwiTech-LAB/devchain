import {
  parseClaudeUsage,
  parseClaudeUsageStream,
  parseResetEpochSeconds,
} from './claude-usage-parser';

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

  it('reads the "at" reset form of Claude Code 2.1.303 on macOS', () => {
    const out = [
      'Current session: 6% used · resets Oct 20 at 7pm (Europe/Kiev)',
      'Current week (all models): 22% used · resets Oct 23 at 12am (Europe/Kiev)',
    ].join('\n');
    // EEST (UTC+3) until Oct 25.
    expect(parseClaudeUsage(out, NOW)).toMatchObject({
      kind: 'ok',
      windows: [
        { id: '5h', usedPercent: 6, resetsAt: epoch(2026, 9, 20, 16, 0) },
        { id: 'weekly', usedPercent: 22, resetsAt: epoch(2026, 9, 22, 21, 0) },
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

describe('parseClaudeUsageStream', () => {
  // The event shapes of Claude Code 2.1.295, cut to the fields the parser reads.
  const stream = (usageReport: unknown, resultText = SAMPLE) =>
    [
      { type: 'system', subtype: 'init', claude_code_version: '2.1.295', tools: ['Bash'] },
      {
        type: 'assistant',
        local_command_run: { command: 'usage', args: '' },
        ...(usageReport === undefined ? {} : { usage_report: usageReport }),
      },
      { type: 'result', subtype: 'success', local_command: 'usage', result: resultText },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');
  const limit = (kind: string, percent: number, resetsAt: unknown, model?: string) => ({
    kind,
    percent,
    resets_at: resetsAt,
    scope: model === undefined ? null : { model: { display_name: model }, surface: null },
  });

  it('maps the usage report and ignores the text', () => {
    const report = {
      rate_limits: {
        limits: [
          limit('session', 2, '2026-10-20T12:50:00.030188+00:00'),
          limit('weekly_all', 76, '2026-10-22T22:00:00.030209+00:00'),
          limit('weekly_scoped', 38, '2026-10-22T22:00:00.030388+00:00', 'Fable'),
        ],
      },
    };
    expect(parseClaudeUsageStream(stream(report, 'garbage'), NOW)).toEqual({
      kind: 'ok',
      windows: [
        {
          id: '5h',
          label: '5-hour limit',
          kind: '5h',
          usedPercent: 2,
          resetsAt: epoch(2026, 9, 20, 12, 50),
        },
        {
          id: 'weekly',
          label: 'Weekly limit',
          kind: 'weekly',
          usedPercent: 76,
          resetsAt: epoch(2026, 9, 22, 22, 0),
        },
      ],
      extras: [
        {
          id: 'weekly-fable',
          label: 'Weekly · Fable',
          kind: 'weekly',
          usedPercent: 38,
          resetsAt: epoch(2026, 9, 22, 22, 0),
        },
      ],
    });
  });

  it('skips unknown kinds and unreadable values, and keeps a null reset as not started', () => {
    const report = {
      rate_limits: {
        limits: [
          limit('session', 0, null),
          limit('weekly_all', 12, 'next Thursday'),
          limit('weekly_all', 13, '2026-10-22T22:00:00+00:00'),
          limit('monthly', 5, '2026-11-01T00:00:00+00:00'),
          limit('weekly_scoped', 9, '2026-10-22T22:00:00+00:00'),
          { ...limit('weekly_scoped', 0, null, 'Opus'), percent: '30' },
        ],
      },
    };
    expect(parseClaudeUsageStream(stream(report), NOW)).toEqual({
      kind: 'ok',
      windows: [
        expect.objectContaining({ id: '5h', usedPercent: 0, resetsAt: null }),
        expect.objectContaining({ id: 'weekly', usedPercent: 13 }),
      ],
      extras: [],
    });
  });

  it.each([
    ['no usage report', undefined],
    ['no rate limits', { rate_limits: null }],
    ['no known limit', { rate_limits: { limits: [limit('monthly', 5, null)] } }],
  ])('falls back to the result text when there is %s', (_case, report) => {
    expect(parseClaudeUsageStream(stream(report), NOW)).toEqual(parseClaudeUsage(SAMPLE, NOW));
    expect(parseClaudeUsageStream(stream(report, 'Total cost: $0.0000\n'), NOW)).toEqual({
      kind: 'not-available',
    });
  });

  it('reads plain text output', () => {
    expect(parseClaudeUsageStream(SAMPLE, NOW)).toEqual(parseClaudeUsage(SAMPLE, NOW));
  });
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
