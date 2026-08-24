import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { useCallback, useState } from 'react';
import { useExternalTaskTimeEntries } from '@/ui/hooks/board/useExternalTaskTimeEntries';
import { epicTimeQueryKeys, resolveEpicTimeZone } from '@/ui/lib/epic-time';
import { ExternalTaskTimeTracking } from './ExternalTaskTimeTracking';

const fetchMock = jest.fn();

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

const connectionEpoch = 'connection-jira-a:4';

function entry(overrides: Record<string, unknown> = {}) {
  return {
    remoteId: '10001',
    durationMs: 3_600_000,
    startedAt: '2026-08-19T10:00:00.000Z',
    note: 'Implementation',
    noteTruncated: false,
    canDelete: true,
    ...overrides,
  };
}

function historyPayload(entries: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    windowDays: 30,
    entries,
    truncated: false,
    hasRunningTimer: false,
    ...overrides,
  };
}

function jsonResponse(payload: unknown) {
  return { ok: true, json: async () => payload };
}

type TimeTrackingHarnessProps = Omit<
  React.ComponentProps<typeof ExternalTaskTimeTracking>,
  'timeEntries' | 'onHistoryOpenChange'
>;

function TimeTrackingHarness(props: TimeTrackingHarnessProps) {
  const scope = `${props.provider}:${props.connectionEpoch ?? ''}:${props.taskId ?? ''}`;
  const [historyDisclosure, setHistoryDisclosure] = useState({ scope, open: false });
  const historyOpen = historyDisclosure.scope === scope && historyDisclosure.open;
  const handleHistoryOpenChange = useCallback(
    (open: boolean) => setHistoryDisclosure({ scope, open }),
    [scope],
  );
  const timeEntries = useExternalTaskTimeEntries(props.provider, props.taskId, {
    enabled: props.enabled,
    historyOpen,
    connectionEpoch: props.connectionEpoch,
    identityAccepted: props.identityAccepted,
    timeTrackingEnabled: props.timeTrackingEnabled,
  });
  return (
    <ExternalTaskTimeTracking
      {...props}
      timeEntries={timeEntries}
      onHistoryOpenChange={handleHistoryOpenChange}
    />
  );
}

function renderBlock(props: Partial<TimeTrackingHarnessProps> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const renderUi = (nextProps: Partial<TimeTrackingHarnessProps>) => (
    <QueryClientProvider client={client}>
      <TimeTrackingHarness
        provider="jira"
        taskId="ENG-1"
        linkedEpicId={null}
        connectionEpoch={connectionEpoch}
        enabled
        identityAccepted
        timeTrackingEnabled
        taskTotalDurationMs={5_400_000}
        sourceUrl="https://acme.atlassian.net/browse/ENG-1"
        {...nextProps}
      />
    </QueryClientProvider>
  );
  const view = render(renderUi(props));
  return {
    ...view,
    client,
    rerenderBlock: (nextProps: Partial<TimeTrackingHarnessProps>) =>
      view.rerender(renderUi({ ...props, ...nextProps })),
  };
}

async function openTimeBlock(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Expand Time tracked' }));
}

async function openHistory(): Promise<void> {
  await openTimeBlock();
  const user = userEvent.setup();
  await user.click(screen.getByText('Recent time entries', { selector: 'summary' }));
}

describe('ExternalTaskTimeTracking', () => {
  let uuidSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchMock.mockReset();
    uuidSpy = jest.spyOn(window.crypto, 'randomUUID').mockReturnValue('generated-operation-id');
  });

  afterEach(() => {
    uuidSpy.mockRestore();
  });

  function serveHistory(payload: unknown): void {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/time-entries') && !init?.method) {
        return Promise.resolve(jsonResponse(payload));
      }
      if (init?.method === 'DELETE') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'deleted',
            receipt: { operationId: 'op-2', phase: 'succeeded' },
          }),
        );
      }
      if (init?.method === 'POST' && String(url).includes('/acknowledge')) {
        return Promise.resolve(jsonResponse({ operationId: 'op-1', phase: 'abandoned_unknown' }));
      }
      if (init?.method === 'POST' && String(url).includes('/verify')) {
        return Promise.resolve(
          jsonResponse({
            receipt: { operationId: 'op-1', phase: 'succeeded' },
            resolved: true,
            resolution: 'created',
          }),
        );
      }
      if (init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'created',
            remoteEntryId: '10002',
            refresh: ['task_detail'],
          }),
        );
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    });
  }

  function estimateSummary(overrides: Record<string, unknown> = {}) {
    return {
      isRoot: true,
      directMinutes: 30,
      totalMinutes: 90,
      items: [],
      taskItems: [
        { epicId: 'epic-root', epicTitle: 'Root task', isDirect: true, minutes: 30 },
        { epicId: 'epic-child', epicTitle: 'Child task', isDirect: false, minutes: 60 },
      ],
      ...overrides,
    };
  }

  function serveEstimate(summary: unknown): void {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/api/epics/') && String(url).includes('/time-logs')) {
        return Promise.resolve(jsonResponse(summary));
      }
      if (String(url).endsWith('/time-entries') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ outcome: 'created', remoteEntryId: '10002', refresh: ['task_detail'] }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload([])));
    });
  }

  it('starts collapsed with the task total and reveals the accepted form on demand', async () => {
    serveHistory(historyPayload([]));
    const { container } = renderBlock();

    const heading = screen.getByRole('heading', { level: 3, name: 'Time tracked' });
    const block = heading.closest('section')!;
    expect(block).toHaveTextContent('1h 30m');
    expect(block).toHaveClass('border', 'border-l-4', 'border-l-primary', 'bg-card');
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('button', { name: 'Expand Time tracked' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(container.querySelector('form[aria-label="Log time"]')).not.toBeVisible();
    expect(screen.getByText('Recent time entries', { selector: 'summary' })).not.toBeVisible();
    expect(container.querySelector('li[data-entry-id]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    await openTimeBlock();

    expect(screen.getByRole('button', { name: 'Collapse Time tracked' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('form', { name: 'Log time' })).toBeVisible();
    expect(
      screen.getByText('Recent time entries', { selector: 'summary' }).closest('details'),
    ).not.toHaveAttribute('open');
    expect(container.querySelector('li[data-entry-id]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads an accepted linked root lazily and places its task breakdown before the manual form', async () => {
    serveEstimate(estimateSummary());
    const { container } = renderBlock({ linkedEpicId: 'epic-root' });
    expect(fetchMock).not.toHaveBeenCalled();

    await openTimeBlock();

    const heading = await screen.findByRole('heading', {
      name: 'DevChain estimated time tracked',
    });
    const panel = heading.closest('section')!;
    const form = screen.getByRole('form', { name: 'Log time' });
    expect(panel.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel).toHaveTextContent('Total including sub-epics');
    expect(panel).toHaveTextContent('1h 30m');
    expect(within(panel).getByText('Root task')).toBeVisible();
    expect(within(panel).getByText('Child task')).toBeVisible();
    expect(within(panel).getByRole('button', { name: 'Log full estimate — 1h 30m' })).toBeEnabled();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/time-logs'))).toHaveLength(
      1,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows a linked sub-epic own total and task row', async () => {
    serveEstimate(
      estimateSummary({
        isRoot: false,
        directMinutes: 45,
        totalMinutes: 45,
        taskItems: [{ epicId: 'epic-child', epicTitle: 'Child task', isDirect: true, minutes: 45 }],
      }),
    );
    renderBlock({ linkedEpicId: 'epic-child' });
    await openTimeBlock();

    const panel = (
      await screen.findByRole('heading', {
        name: 'DevChain estimated time tracked',
      })
    ).closest('section')!;
    expect(within(panel).getByText('Total')).toBeVisible();
    expect(within(panel).queryByText('Total including sub-epics')).toBeNull();
    expect(within(panel).getByText('Child task')).toBeVisible();
    expect(within(panel).getAllByText('45m')).toHaveLength(2);
  });

  it.each([
    ['collapsed', { linkedEpicId: 'epic-root' }, false],
    ['unlinked', { linkedEpicId: null }, true],
    ['identity unaccepted', { linkedEpicId: 'epic-root', identityAccepted: false }, true],
    ['unsupported', { linkedEpicId: 'epic-root', timeTrackingEnabled: false }, true],
    ['disabled', { linkedEpicId: 'epic-root', enabled: false }, true],
  ])('issues no native estimate request while %s', async (_case, props, expand) => {
    serveEstimate(estimateSummary());
    renderBlock(props);
    if (expand) await openTimeBlock();
    await act(async () => Promise.resolve());

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/time-logs'))).toHaveLength(
      0,
    );
  });

  it('keeps the manual form enabled when the native estimate fails', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/time-logs')) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
      }
      return Promise.resolve(jsonResponse(historyPayload([])));
    });
    renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();

    expect(await screen.findByText('DevChain estimate is unavailable.')).toBeVisible();
    expect(screen.getByLabelText('Duration')).toBeEnabled();
    expect(screen.getByLabelText('Note (optional)')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Log time' })).toBeEnabled();
  });

  it.each([
    [0, 'No estimated agent time recorded yet.'],
    [10_081, 'The estimate exceeds the 7-day limit for one time entry.'],
  ])('does not offer an estimate dispatch for %s minutes', async (totalMinutes, expectedCopy) => {
    serveEstimate(
      estimateSummary({
        totalMinutes,
        directMinutes: totalMinutes,
        taskItems:
          totalMinutes === 0
            ? []
            : [
                {
                  epicId: 'epic-root',
                  epicTitle: 'Root task',
                  isDirect: true,
                  minutes: totalMinutes,
                },
              ],
      }),
    );
    renderBlock({ linkedEpicId: `epic-${totalMinutes}` });
    await openTimeBlock();

    expect(await screen.findByText(expectedCopy)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Log full estimate/ })).toBeNull();
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST'),
    ).toBe(false);
  });

  it('submits one immutable estimate snapshot without changing the manual draft', async () => {
    let resolveCreate:
      | ((response: { ok: boolean; json: () => Promise<unknown> }) => void)
      | undefined;
    serveEstimate(estimateSummary());
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-logs')) {
        return Promise.resolve(jsonResponse(estimateSummary()));
      }
      if (String(url).endsWith('/time-entries') && init?.method === 'POST') {
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      }
      return Promise.resolve(jsonResponse(historyPayload([])));
    });
    const user = userEvent.setup();
    const confirmedAtMs = Date.parse('2026-08-23T12:00:00.000Z');
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(confirmedAtMs);
    const { client } = renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();
    await screen.findByRole('button', { name: 'Log full estimate — 1h 30m' });
    await user.type(screen.getByLabelText('Duration'), '15m');
    await user.type(screen.getByLabelText('Note (optional)'), 'Keep this manual draft');

    await user.click(screen.getByRole('button', { name: 'Log full estimate — 1h 30m' }));
    const confirmation = screen.getByRole('dialog', { name: 'Log the full DevChain estimate?' });
    expect(within(confirmation).getByText('Total including sub-epics: 1h 30m')).toBeVisible();
    expect(within(confirmation).getByText(/does not deduct existing provider time/)).toBeVisible();
    expect(within(confirmation).getByText(/another full-total entry/)).toBeVisible();

    act(() => {
      client.setQueryData(
        epicTimeQueryKeys.detail('epic-root', resolveEpicTimeZone()),
        estimateSummary({ totalMinutes: 120 }),
      );
    });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Log full estimate — 2h', hidden: true }),
      ).toHaveTextContent('2h'),
    );
    expect(within(confirmation).getByText('Total including sub-epics: 1h 30m')).toBeVisible();

    await user.click(within(confirmation).getByRole('button', { name: 'Log full estimate' }));
    nowSpy.mockRestore();
    await waitFor(() => expect(resolveCreate).toBeDefined());
    expect(screen.getByLabelText('Duration')).toHaveValue('15m');
    expect(screen.getByLabelText('Duration')).toBeEnabled();
    expect(screen.getByLabelText('Note (optional)')).toHaveValue('Keep this manual draft');
    expect(screen.getByLabelText('Note (optional)')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Log time' })).toBeDisabled();

    const createCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/time-entries') &&
        (init as RequestInit | undefined)?.method === 'POST',
    )!;
    expect((createCall[1] as RequestInit).body).toBe(
      JSON.stringify({
        startedAt: '2026-08-23T10:30:00.000Z',
        durationMs: 5_400_000,
        note: 'DevChain estimated agent time',
      }),
    );

    resolveCreate!(
      jsonResponse({ outcome: 'created', remoteEntryId: '10002', refresh: ['task_detail'] }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Log time' })).toBeEnabled());
    expect(screen.getByLabelText('Duration')).toHaveValue('15m');
    expect(screen.getByLabelText('Note (optional)')).toHaveValue('Keep this manual draft');
    expect(screen.getByRole('status', { hidden: true })).toHaveTextContent(
      'DevChain estimate added.',
    );
  });

  it('resets an open estimate confirmation when the operation scope changes', async () => {
    serveEstimate(estimateSummary());
    const user = userEvent.setup();
    const { rerenderBlock } = renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();
    await user.click(await screen.findByRole('button', { name: 'Log full estimate — 1h 30m' }));
    expect(screen.getByRole('dialog', { name: 'Log the full DevChain estimate?' })).toBeVisible();

    rerenderBlock({ connectionEpoch: 'connection-jira-b:5' });

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Log the full DevChain estimate?' })).toBeNull(),
    );
    expect(screen.getByRole('button', { name: 'Expand Time tracked' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('keeps the total visible when the history request fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
    renderBlock();
    await openHistory();

    const block = screen
      .getByRole('heading', { level: 3, name: 'Time tracked' })
      .closest('section')!;
    expect(block).toHaveTextContent('1h 30m');
    expect(await screen.findByText('Time entries unavailable')).toBeVisible();
  });

  it('labels the history block and renders rows with conditional delete', async () => {
    serveHistory(
      historyPayload([
        entry(),
        entry({
          remoteId: '10002',
          canDelete: false,
          note: 'x'.repeat(10_000) + 'more',
          noteTruncated: true,
          durationMs: 1_800_000,
        }),
      ]),
    );
    renderBlock();
    await openHistory();

    expect(screen.getByText('Your entries · last 30 days')).toBeVisible();
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveClass('grid', 'min-w-0');
    expect(within(rows[0]!).getByText('Duration')).toHaveClass('sm:sr-only');
    expect(within(rows[0]!).getByText('Started')).toHaveClass('sm:sr-only');
    expect(within(rows[0]!).getByText('Note')).toHaveClass('sm:sr-only');
    expect(within(rows[0]!).getByText('1h')).toBeVisible();
    expect(within(rows[0]!).getByText(/2026/)).toBeVisible();
    expect(within(rows[0]!).getByText('Implementation')).toBeVisible();
    expect(within(rows[0]!).getByRole('button', { name: /Delete 1h entry started/ })).toBeVisible();
    // Foreign or non-deletable entries never receive a Delete affordance.
    expect(within(rows[1]!).queryByRole('button', { name: /Delete/ })).toBeNull();
    expect(within(rows[1]!).getByText(/note was shortened/)).toBeVisible();
  });

  it('hides cached rows again when history closes', async () => {
    serveHistory(historyPayload([entry()]));
    const user = userEvent.setup();
    const { container } = renderBlock();
    await openHistory();

    await waitFor(() => expect(container.querySelector('li[data-entry-id]')).not.toBeNull());
    await user.click(screen.getByText('Recent time entries', { selector: 'summary' }));

    await waitFor(() => expect(container.querySelector('li[data-entry-id]')).toBeNull());
    expect(screen.queryByText('Implementation')).toBeNull();
  });

  it('closes and suppresses recent history when the complete block folds', async () => {
    serveHistory(historyPayload([entry()]));
    const user = userEvent.setup();
    const { container } = renderBlock();
    await openHistory();

    await waitFor(() => expect(container.querySelector('li[data-entry-id]')).not.toBeNull());
    await user.click(screen.getByRole('button', { name: 'Collapse Time tracked' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Expand Time tracked' })).toHaveAttribute(
        'aria-expanded',
        'false',
      ),
    );
    expect(container.querySelector('li[data-entry-id]')).toBeNull();
    expect(
      screen.getByText('Recent time entries', { selector: 'summary' }).closest('details'),
    ).not.toHaveAttribute('open');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await openTimeBlock();
    expect(screen.getByRole('form', { name: 'Log time' })).toBeVisible();
    expect(container.querySelector('li[data-entry-id]')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['task', { taskId: 'ENG-2' }],
    ['connection', { connectionEpoch: 'connection-jira-b:5' }],
  ])('resets closed history without requesting it after a %s change', async (_case, nextProps) => {
    serveHistory(historyPayload([entry()]));
    const { container, rerenderBlock } = renderBlock();
    await openHistory();
    await waitFor(() => expect(container.querySelector('li[data-entry-id]')).not.toBeNull());
    fetchMock.mockClear();

    rerenderBlock(nextProps);

    await waitFor(() =>
      expect(
        screen.getByText('Recent time entries', { selector: 'summary' }).closest('details'),
      ).not.toHaveAttribute('open'),
    );
    expect(screen.getByRole('button', { name: 'Expand Time tracked' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(container.querySelector('li[data-entry-id]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders incomplete and running-timer notices plus the empty state', async () => {
    serveHistory(historyPayload([], { truncated: true, hasRunningTimer: true }));
    renderBlock();
    await openHistory();

    expect(
      await screen.findByText(
        'Incomplete list — the provider did not return the full 30-day window.',
      ),
    ).toBeVisible();
    expect(screen.getByText('A running timer is active in the provider.')).toBeVisible();
    expect(screen.getByText('No entries in the last 30 days.')).toBeVisible();
  });

  it('shows unavailable copy when the provider lacks the log_time capability', async () => {
    renderBlock({ timeTrackingEnabled: false, taskTotalDurationMs: null });
    await openTimeBlock();

    expect(screen.getByText('Time tracking is unavailable.')).toBeVisible();
    expect(screen.queryByLabelText('Duration')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid durations locally without a request', async () => {
    serveHistory(historyPayload([]));
    const user = userEvent.setup();
    renderBlock();
    await openTimeBlock();

    await user.type(screen.getByLabelText('Duration'), '1.5h');
    await user.click(screen.getByRole('button', { name: 'Log time' }));

    expect(screen.getByText(/Enter a duration like 15m, 5h, 1h 30m/)).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/time-entries'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('derives startedAt from one submit timestamp without an exact start', async () => {
    serveHistory(historyPayload([]));
    const user = userEvent.setup();
    const submitTime = Date.parse('2026-08-22T12:00:00.000Z');
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(submitTime);
    renderBlock();
    await openTimeBlock();

    await user.type(screen.getByLabelText('Duration'), '1h 30m');
    await user.type(screen.getByLabelText('Note (optional)'), 'Deep work');
    await user.click(screen.getByRole('button', { name: 'Log time' }));
    nowSpy.mockRestore();

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/time-entries') && (init as RequestInit).method === 'POST',
        ),
      ).toBe(true),
    );
    const createCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    )!;
    expect((createCall[1] as RequestInit).body).toBe(
      JSON.stringify({
        startedAt: '2026-08-22T10:30:00.000Z',
        durationMs: 5_400_000,
        note: 'Deep work',
      }),
    );
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => String(url).endsWith('/time-entries') && !init?.method,
      ),
    ).toHaveLength(0);
  });

  it('uses the optional exact start behind the disclosure', async () => {
    serveHistory(historyPayload([]));
    const user = userEvent.setup();
    renderBlock();
    await openTimeBlock();

    expect(screen.queryByLabelText('Started at')).toBeNull();
    const exactStartButton = screen.getByRole('button', { name: /Add exact start time/ });
    expect(exactStartButton).toHaveClass('border', 'h-9');
    await user.click(exactStartButton);
    expect(screen.getByLabelText('Started at')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hide exact start time' })).toBeVisible();

    await user.type(screen.getByLabelText('Duration'), '30');
    await user.type(screen.getByLabelText('Started at'), '2026-08-22T09:30');
    await user.click(screen.getByRole('button', { name: 'Log time' }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true),
    );
    const createCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    )!;
    const body = JSON.parse((createCall[1] as RequestInit).body as string) as {
      startedAt: string;
    };
    expect(body.startedAt).toBe(new Date('2026-08-22T09:30').toISOString());
  });

  it('offers Verify and Open in source — never Retry — after an unknown create, then unlocks through acknowledgement', async () => {
    serveHistory(historyPayload([]));
    const user = userEvent.setup();
    renderBlock();
    await openTimeBlock();

    // The second submission flips every create to an unknown outcome.
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/time-entries') && !init?.method) {
        return Promise.resolve(jsonResponse(historyPayload([])));
      }
      if (init?.method === 'POST' && String(url).includes('/acknowledge')) {
        return Promise.resolve(jsonResponse({ operationId: 'op-1', phase: 'abandoned_unknown' }));
      }
      if (init?.method === 'POST' && String(url).includes('/verify')) {
        return Promise.resolve(
          jsonResponse({
            receipt: { operationId: 'op-1', phase: 'outcome_unknown' },
            resolved: false,
            resolution: 'completeness_not_provable',
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          outcome: 'outcome_unknown',
          receipt: { operationId: 'op-1', phase: 'outcome_unknown' },
        }),
      );
    });

    await user.type(screen.getByLabelText('Duration'), '15m');
    await user.click(screen.getByRole('button', { name: 'Log time' }));

    expect(await screen.findByText('Last submission unconfirmed')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Verify' })).toBeVisible();
    expect(screen.getByRole('link', { name: /Open in source/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Log time' })).toBeDisabled();

    // Verification that cannot prove the outcome keeps the form locked.
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(screen.getByText(/cannot prove what happened/)).toBeVisible());
    expect(screen.getByRole('button', { name: 'Log time' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Acknowledge duplicate risk' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Log time' })).toBeEnabled());
  });

  it('hides Verify but keeps Open in source and Acknowledge after epoch replacement', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/acknowledge')) {
        return Promise.resolve(
          jsonResponse({ operationId: 'op-epoch', phase: 'abandoned_unknown' }),
        );
      }
      if (String(url).endsWith('/time-entries') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'outcome_unknown',
            receipt: { operationId: 'op-epoch', phase: 'outcome_unknown' },
          }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload([])));
    });
    const user = userEvent.setup();
    const { rerenderBlock } = renderBlock();
    await openTimeBlock();
    await user.type(screen.getByLabelText('Duration'), '15m');
    await user.click(screen.getByRole('button', { name: 'Log time' }));
    expect(await screen.findByText('Last submission unconfirmed')).toBeVisible();

    rerenderBlock({ connectionEpoch: 'connection-jira-b:5' });
    await openTimeBlock();

    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
    expect(screen.getByRole('link', { name: /Open in source/ })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Acknowledge duplicate risk' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Log time' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Acknowledge duplicate risk' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Log time' })).toBeEnabled());
  });

  it('confirms deletion naming duration and date, warns about the remote entry, and refocuses the next row', async () => {
    serveHistory(
      historyPayload([
        entry({ remoteId: '10001' }),
        entry({ remoteId: '10002', durationMs: 1_800_000 }),
      ]),
    );
    const user = userEvent.setup();
    renderBlock();
    await openHistory();

    const firstRow = (await screen.findAllByRole('listitem'))[0]!;
    await user.click(within(firstRow).getByRole('button', { name: /Delete 1h entry started/ }));

    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(
        /This permanently removes the 1h entry started .+ from the provider\./,
      ),
    ).toBeVisible();
    expect(within(dialog).getByText(/This action cannot be undone/)).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Delete entry' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/time-entries/10001') &&
            (init as RequestInit).method === 'DELETE',
        ),
      ).toBe(true);
    });
    // Focus lands on the next remaining row's Delete button.
    await waitFor(() => {
      expect(document.activeElement?.dataset.entryDelete).toBeDefined();
      expect(document.activeElement?.textContent).toBe('Delete');
    });
    expect(screen.getByRole('status', { hidden: true })).toHaveTextContent('Time entry deleted.');
  });

  it('returns focus to the duration form when the last row is deleted', async () => {
    let deleted = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deleted = true;
        return Promise.resolve(
          jsonResponse({
            outcome: 'deleted',
            receipt: { operationId: 'op-2', phase: 'succeeded' },
          }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload(deleted ? [] : [entry()])));
    });
    const user = userEvent.setup();
    renderBlock();
    await openHistory();

    await user.click(await screen.findByRole('button', { name: /Delete 1h entry started/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete entry' }));

    await waitFor(() => {
      expect(screen.getByText('No entries in the last 30 days.')).toBeVisible();
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Duration')).toHaveFocus();
    });
  });

  it('cancelling the confirmation returns to the row without a request', async () => {
    serveHistory(historyPayload([entry()]));
    const user = userEvent.setup();
    renderBlock();
    await openHistory();

    await user.click(await screen.findByRole('button', { name: /Delete 1h entry started/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
      ),
    ).toBe(false);
  });

  it('keeps the confirmation open on rejection, showing and announcing the error for the same entry', async () => {
    serveHistory(historyPayload([entry({ remoteId: '10001' })]));
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return { ok: false, status: 403, json: async () => ({ message: 'nope' }) };
      }
      return jsonResponse(historyPayload([entry({ remoteId: '10001' })]));
    });
    const user = userEvent.setup();
    renderBlock();
    await openHistory();

    await user.click(await screen.findByRole('button', { name: /Delete 1h entry started/ }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete entry' }));

    // The dialog stays mounted and renders the classified error.
    expect(await screen.findByRole('dialog')).toBeVisible();
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/nope/i);
    // The same failure is announced through the existing live region.
    expect(screen.getByRole('status', { hidden: true })).toHaveTextContent(
      'The time entry could not be deleted.',
    );
    // Controls unlock again after settle so the user can cancel or retry
    // deliberately through a fresh confirmation.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('locks Cancel, Delete entry, and dismissal while deletion is pending', async () => {
    let resolveDelete:
      | ((response: { ok: boolean; json: () => Promise<unknown> }) => void)
      | undefined;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return new Promise((resolve) => {
          resolveDelete = resolve;
        });
      }
      return jsonResponse(historyPayload([entry()]));
    });
    const user = userEvent.setup();
    renderBlock();
    await openHistory();

    await user.click(await screen.findByRole('button', { name: /Delete 1h entry started/ }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete entry' }));

    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Deleting…' })).toBeDisabled();
    });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();

    // Escape and outside interaction cannot dismiss a pending deletion.
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeVisible();

    resolveDelete!(
      jsonResponse({ outcome: 'deleted', receipt: { operationId: 'op', phase: 'succeeded' } }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps an ambiguous delete unconfirmed without claiming the entry was deleted', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return jsonResponse({
          outcome: 'outcome_unknown',
          receipt: { operationId: 'op-delete-unknown', phase: 'outcome_unknown' },
        });
      }
      return jsonResponse(historyPayload([entry()]));
    });
    const user = userEvent.setup();
    renderBlock();
    await openHistory();

    await user.click(await screen.findByRole('button', { name: /Delete 1h entry started/ }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete entry' }));

    expect(await screen.findByText('Last submission unconfirmed')).toBeVisible();
    expect(dialog).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Delete entry' })).toBeDisabled();
    expect(screen.getByRole('status', { hidden: true })).toHaveTextContent(
      'The delete result is unconfirmed. Verify it before retrying.',
    );
    expect(screen.getByRole('status', { hidden: true })).not.toHaveTextContent(
      'Time entry deleted.',
    );
  });

  it('never renders a prior entry error on a new confirmation', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return { ok: false, status: 403, json: async () => ({ message: 'nope' }) };
      }
      return jsonResponse(
        historyPayload([entry({ remoteId: '10001' }), entry({ remoteId: '10002' })]),
      );
    });
    const user = userEvent.setup();
    renderBlock();
    await openHistory();

    // First entry's delete rejects.
    const rows = await screen.findAllByRole('listitem');
    await user.click(within(rows[0]!).getByRole('button', { name: /Delete 1h entry started/ }));
    let dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete entry' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/nope/i);

    // Cancel out, then open the second entry: the stale error must be gone.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(within(rows[1]!).getByRole('button', { name: /Delete 1h entry started/ }));
    dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(within(dialog).getByText(/This permanently removes the 1h entry/)).toBeVisible();
  });

  it('suppresses history traffic while identity is unaccepted', () => {
    serveHistory(historyPayload([entry()]));
    renderBlock({ identityAccepted: false });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Your entries · last 30 days')).toBeNull();
  });

  it('has no axe violations in the form and expanded history', async () => {
    serveHistory(historyPayload([entry()]));
    const { container } = renderBlock();
    await openHistory();

    await waitFor(() => expect(screen.getByText('Implementation')).toBeVisible());
    expect(await axe(container)).toHaveNoViolations();
  });
});
