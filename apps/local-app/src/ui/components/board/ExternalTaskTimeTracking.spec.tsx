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
const PROJECT_ID = 'project-1';

function entry(overrides: Record<string, unknown> = {}) {
  return {
    remoteId: '10001',
    durationMs: 3_600_000,
    startedAt: '2026-08-19T10:00:00.000Z',
    note: 'Implementation',
    noteTruncated: false,
    canEdit: true,
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

function futureReceiptIso(ms = 3_600_000): string {
  return new Date(Date.now() + ms).toISOString();
}

const OriginalDateTimeFormat = Intl.DateTimeFormat;

/**
 * Simulates an operating-system or browser time-zone change: the no-argument
 * resolver reports the given zone while every explicitly configured formatter
 * keeps its real behavior.
 */
function mockBrowserTimeZone(timeZone: string): jest.SpyInstance {
  return jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(((
    locale?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
  ) => {
    if (locale === undefined && options === undefined) {
      const resolved = new OriginalDateTimeFormat().resolvedOptions();
      return {
        resolvedOptions: () => ({ ...resolved, timeZone }),
      } as unknown as Intl.DateTimeFormat;
    }
    return new OriginalDateTimeFormat(locale, options);
  }) as unknown as typeof Intl.DateTimeFormat);
}

function estimateCreateCalls(): [string, RequestInit][] {
  return fetchMock.mock.calls.filter(
    ([url, init]) =>
      String(url).includes('/estimate-time-entries?') &&
      (init as RequestInit | undefined)?.method === 'POST',
  ) as [string, RequestInit][];
}

function timeLogUrls(): string[] {
  return fetchMock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.includes('/time-logs'));
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
    projectId: PROJECT_ID,
    remoteScopeKey: props.remoteScopeKey,
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
        projectId={PROJECT_ID}
        remoteScopeKey="acme.atlassian.net"
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
  await user.click(screen.getByLabelText('Recent time entries'));
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
      if (String(url).includes('/time-entries?') && !init?.method) {
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
      if (init?.method === 'PUT') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'updated',
            receipt: { operationId: 'op-edit', kind: 'update', phase: 'succeeded' },
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
      includesRelatedTime: false,
      items: [{ activityDate: '2026-08-29', agentId: 'agent-1', agentName: 'Coder', minutes: 90 }],
      taskItems: [
        { epicId: 'epic-root', epicTitle: 'Root task', isDirect: true, minutes: 30 },
        { epicId: 'epic-child', epicTitle: 'Child task', isDirect: false, minutes: 60 },
      ],
      ...overrides,
    };
  }

  function estimateState(overrides: Record<string, unknown> = {}) {
    return {
      initialized: false,
      revision: 0,
      loggedMinutes: 0,
      aggregationTimeZone: null,
      days: [],
      unallocatedLoggedMinutes: 0,
      pendingDisposition: 'none',
      canVerify: false,
      verifyExpiresAt: null,
      pending: null,
      ...overrides,
    };
  }

  function serveEstimate(summary: unknown): void {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/api/epics/') && String(url).includes('/time-logs')) {
        return Promise.resolve(jsonResponse(summary));
      }
      if (String(url).includes('/estimate-log-state?') && !init?.method) {
        return Promise.resolve(jsonResponse(estimateState()));
      }
      if (String(url).includes('/estimate-time-entries?') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'logged',
            entriesLogged: 1,
            minutesLogged: 90,
            hasMore: false,
            stoppedReason: 'completed',
            state: estimateState({
              initialized: true,
              revision: 2,
              loggedMinutes: 90,
            }),
          }),
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
    expect(block).toHaveClass('border', 'bg-card');
    const toggle = screen.getByRole('button', { name: 'Expand Time tracked' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('form[aria-label="Log time"]')).not.toBeVisible();
    expect(screen.getByLabelText('Recent time entries')).not.toBeVisible();
    expect(container.querySelector('li[data-entry-id]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    const user = userEvent.setup();
    toggle.focus();
    await user.keyboard('{Enter}');

    expect(screen.getByRole('button', { name: 'Collapse Time tracked' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('form', { name: 'Log time' })).toBeVisible();
    expect(screen.getByLabelText('Recent time entries').closest('details')).not.toHaveAttribute(
      'open',
    );
    expect(container.querySelector('li[data-entry-id]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads linked estimate metrics in the collapsed header and reuses them in the panel', async () => {
    serveEstimate(estimateSummary());
    const { container } = renderBlock({ linkedEpicId: 'epic-root' });

    const toggle = screen.getByRole('button', { name: 'Expand Time tracked' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(toggle).getByText('Current estimate')).toBeVisible();
    expect(within(toggle).getByText('Logged')).toBeVisible();
    expect(within(toggle).getByText('New unlogged')).toBeVisible();
    await waitFor(() =>
      expect(within(toggle).getByText('Current estimate').nextElementSibling).toHaveTextContent(
        '1h 30m',
      ),
    );
    expect(within(toggle).getByText('Logged').nextElementSibling).toHaveTextContent('0m');
    expect(within(toggle).getByText('New unlogged').nextElementSibling).toHaveTextContent('1h 30m');
    expect(container.querySelector('form[aria-label="Log time"]')).not.toBeVisible();

    await openTimeBlock();

    const heading = await screen.findByRole('heading', {
      name: 'DevChain estimated time tracked',
    });
    const panel = heading.closest('section')!;
    const form = screen.getByRole('form', { name: 'Log time' });
    expect(panel.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel).toHaveTextContent('Current estimate');
    expect(panel).toHaveTextContent('Already logged');
    expect(panel).toHaveTextContent('Ready to log');
    expect(panel).toHaveTextContent('1h 30m');
    expect(within(panel).getByText('Root task')).toBeVisible();
    expect(within(panel).getByText('Child task')).toBeVisible();
    expect(within(panel).getByRole('button', { name: 'Review & log 1h 30m' })).toBeEnabled();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/time-logs'))).toHaveLength(
      1,
    );
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/estimate-log-state?')),
    ).toHaveLength(1);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows compact placeholders while collapsed estimate metrics load', () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    renderBlock({ linkedEpicId: 'epic-root' });

    const toggle = screen.getByRole('button', { name: 'Expand Time tracked' });
    expect(within(toggle).getByText('Current estimate').nextElementSibling).toHaveTextContent('—');
    expect(within(toggle).getByText('Logged').nextElementSibling).toHaveTextContent('—');
    expect(within(toggle).getByText('New unlogged').nextElementSibling).toHaveTextContent('—');
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
    expect(within(panel).getByText('Current estimate')).toBeVisible();
    expect(within(panel).getByText('Child task')).toBeVisible();
    expect(within(panel).getAllByText('45m')).toHaveLength(4);
  });

  function groupedEstimateSummary(): Record<string, unknown> {
    return estimateSummary({
      totalMinutes: 120,
      directMinutes: 30,
      includesRelatedTime: true,
      taskItems: [
        {
          epicId: 'epic-root',
          epicTitle: 'Root task',
          isDirect: true,
          minutes: 30,
          groupEpicId: 'epic-root',
          groupEpicTitle: 'Root task',
        },
        {
          epicId: 'epic-child',
          epicTitle: 'Child task',
          isDirect: false,
          minutes: 60,
          groupEpicId: 'epic-root',
          groupEpicTitle: 'Root task',
        },
        {
          epicId: 'epic-routed',
          epicTitle: 'Routed task',
          isDirect: false,
          minutes: 15,
          groupEpicId: 'epic-routed',
          groupEpicTitle: 'Routed task',
        },
        {
          epicId: 'epic-routed-child',
          epicTitle: 'Routed child task',
          isDirect: false,
          minutes: 15,
          groupEpicId: 'epic-routed',
          groupEpicTitle: 'Routed task',
        },
      ],
    });
  }

  it('renders collapsed contributor groups with totals for a healthy payload', async () => {
    serveEstimate(groupedEstimateSummary());
    const user = userEvent.setup();
    const { container } = renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();

    const panel = (
      await screen.findByRole('heading', { name: 'DevChain estimated time tracked' })
    ).closest('section')!;
    expect(
      within(panel).getByText('Only DevChain activity that rolls into this remote task is shown.'),
    ).toBeVisible();

    const focalTrigger = within(panel).getByRole('button', {
      name: /This task 1h 30m/,
    });
    expect(focalTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(focalTrigger).toHaveAttribute('aria-controls');
    expect(within(panel).queryByText('Own activity')).toBeNull();
    expect(within(panel).queryByText('Child task')).toBeNull();

    const relatedTrigger = within(panel).getByRole('button', {
      name: /Related: Routed task 30m/,
    });
    expect(relatedTrigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(focalTrigger);
    expect(focalTrigger).toHaveAttribute('aria-expanded', 'true');
    expect(within(panel).getByText('Own activity')).toBeVisible();
    expect(within(panel).getByText('Child task')).toBeVisible();
    // The two group totals (1h 30m + 30m) sum to the 2h header estimate.
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders the exact legacy flat list when one row lacks valid group metadata', async () => {
    serveEstimate(
      estimateSummary({
        taskItems: [
          {
            epicId: 'epic-root',
            epicTitle: 'Root task',
            isDirect: true,
            minutes: 30,
            groupEpicId: 'epic-root',
            groupEpicTitle: 'Root task',
          },
          { epicId: 'epic-child', epicTitle: 'Child task', isDirect: false, minutes: 60 },
        ],
      }),
    );
    renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();

    const panel = (
      await screen.findByRole('heading', { name: 'DevChain estimated time tracked' })
    ).closest('section')!;
    const list = within(panel).getByRole('list', { name: 'Contributing DevChain tasks' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual(['Root task30m', 'Child task1h']);
    expect(within(panel).queryByText('This task')).toBeNull();
    expect(within(panel).queryByText(/Related:/)).toBeNull();
    expect(
      within(panel).queryByText(
        'Only DevChain activity that rolls into this remote task is shown.',
      ),
    ).toBeNull();
  });

  it('resets group expansion when the same remote task relinks to another Epic', async () => {
    serveEstimate(groupedEstimateSummary());
    const user = userEvent.setup();
    const { client, rerenderBlock } = renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();
    const trigger = await screen.findByRole('button', { name: /This task/ });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Own activity')).toBeVisible();

    // Priming the next Epic's cache keeps the panel mounted across the
    // relink; only the contributor list's focalEpicId key changes.
    act(() => {
      client.setQueryData(
        epicTimeQueryKeys.detail('epic-relLinked', resolveEpicTimeZone()),
        groupedEstimateSummary(),
      );
    });
    rerenderBlock({ linkedEpicId: 'epic-relLinked' });

    // The previously focal group re-labels as related and starts collapsed.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Related: Root task 1h 30m/ })).toHaveAttribute(
        'aria-expanded',
        'false',
      ),
    );
    expect(screen.queryByText('Own activity')).toBeNull();
  });

  it.each([
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
    expect(screen.queryByText('Current estimate')).toBeNull();
    expect(screen.queryByText('Logged')).toBeNull();
    expect(screen.queryByText('New unlogged')).toBeNull();
  });

  it('keeps the manual form enabled when the native estimate fails', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/time-logs')) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
      }
      if (String(url).includes('/estimate-log-state?')) {
        return Promise.resolve(jsonResponse(estimateState()));
      }
      return Promise.resolve(jsonResponse(historyPayload([])));
    });
    renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();

    expect(await screen.findByText('DevChain estimate is unavailable.')).toBeVisible();
    expect(screen.getByLabelText('Duration')).toBeEnabled();
    expect(screen.getByLabelText('Note (optional)')).toBeEnabled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Log time' })).toBeEnabled());
  });

  it.each([[0, 'Estimate is up to date.']])(
    'does not offer an estimate dispatch for %s minutes',
    async (totalMinutes, expectedCopy) => {
      serveEstimate(
        estimateSummary({
          totalMinutes,
          directMinutes: totalMinutes,
          items: [],
          taskItems: [],
        }),
      );
      renderBlock({ linkedEpicId: `epic-${totalMinutes}` });
      await openTimeBlock();

      expect(await screen.findByText(expectedCopy)).toBeVisible();
      expect(screen.queryByRole('button', { name: /Log new estimate/ })).toBeNull();
      expect(
        fetchMock.mock.calls.some(
          ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(false);
    },
  );

  it('submits one immutable estimate snapshot without changing the manual draft', async () => {
    let resolveCreate:
      | ((response: { ok: boolean; json: () => Promise<unknown> }) => void)
      | undefined;
    serveEstimate(estimateSummary());
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-logs')) {
        return Promise.resolve(jsonResponse(estimateSummary()));
      }
      if (String(url).includes('/estimate-log-state?') && !init?.method) {
        return Promise.resolve(jsonResponse(estimateState()));
      }
      if (String(url).includes('/estimate-time-entries?') && init?.method === 'POST') {
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      }
      return Promise.resolve(jsonResponse(historyPayload([])));
    });
    const user = userEvent.setup();
    const { client } = renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();
    await screen.findByRole('button', { name: 'Review & log 1h 30m' });
    await user.type(screen.getByLabelText('Duration'), '15m');
    await user.type(screen.getByLabelText('Note (optional)'), 'Keep this manual draft');

    await user.click(screen.getByRole('button', { name: 'Review & log 1h 30m' }));
    const confirmation = screen.getByRole('dialog', {
      name: 'Log 1h 30m of new time?',
    });
    expect(within(confirmation).getByText('Current total').nextElementSibling).toHaveTextContent(
      '1h 30m',
    );
    expect(within(confirmation).getByText('Already logged').nextElementSibling).toHaveTextContent(
      '0m',
    );
    expect(within(confirmation).getByText('To log now').nextElementSibling).toHaveTextContent(
      '1h 30m',
    );
    expect(within(confirmation).getByText(/Only unlogged time will be added/)).toBeVisible();

    act(() => {
      client.setQueryData(
        epicTimeQueryKeys.detail('epic-root', resolveEpicTimeZone()),
        estimateSummary({ totalMinutes: 120 }),
      );
    });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Review & log 2h', hidden: true }),
      ).toHaveTextContent('2h'),
    );
    expect(within(confirmation).getByText('Current total').nextElementSibling).toHaveTextContent(
      '1h 30m',
    );

    await user.click(within(confirmation).getByRole('button', { name: 'Log 1h 30m' }));
    await waitFor(() => expect(resolveCreate).toBeDefined());
    expect(screen.getByLabelText('Duration')).toHaveValue('15m');
    expect(screen.getByLabelText('Duration')).toBeEnabled();
    expect(screen.getByLabelText('Note (optional)')).toHaveValue('Keep this manual draft');
    expect(screen.getByLabelText('Note (optional)')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Log time' })).toBeDisabled();

    const createCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes('/estimate-time-entries?') &&
        (init as RequestInit | undefined)?.method === 'POST',
    )!;
    expect((createCall[1] as RequestInit).body).toBe(
      JSON.stringify({
        scopeKey: 'acme.atlassian.net',
        requestKey: 'generated-operation-id',
        timeZone: resolveEpicTimeZone(),
        estimateTotalMinutes: 90,
        expectedRevision: 0,
        dailySnapshot: [{ activityDate: '2026-08-29', minutes: 90 }],
      }),
    );

    resolveCreate!(
      jsonResponse({
        outcome: 'logged',
        entriesLogged: 1,
        minutesLogged: 90,
        hasMore: false,
        stoppedReason: 'completed',
        state: estimateState({ initialized: true, revision: 2, loggedMinutes: 90 }),
      }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Log time' })).toBeEnabled());
    expect(screen.getByLabelText('Duration')).toHaveValue('15m');
    expect(screen.getByLabelText('Note (optional)')).toHaveValue('Keep this manual draft');
    expect(screen.getByRole('status', { hidden: true })).toHaveTextContent(
      'New DevChain estimate time logged: 1 entry (1h 30m).',
    );
  });

  it('shows and submits only the later unlogged estimate delta', async () => {
    const state = estimateState({
      initialized: true,
      revision: 5,
      loggedMinutes: 90,
      aggregationTimeZone: resolveEpicTimeZone(),
      days: [{ activityDate: '2026-08-29', loggedMinutes: 90 }],
      unallocatedLoggedMinutes: 0,
    });
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-logs')) {
        return Promise.resolve(
          jsonResponse(
            estimateSummary({
              totalMinutes: 120,
              directMinutes: 120,
              items: [
                {
                  activityDate: '2026-08-29',
                  agentId: 'agent-1',
                  agentName: 'Coder',
                  minutes: 120,
                },
              ],
              taskItems: [
                { epicId: 'epic-root', epicTitle: 'Root task', isDirect: true, minutes: 120 },
              ],
            }),
          ),
        );
      }
      if (String(url).includes('/estimate-log-state?')) {
        return Promise.resolve(jsonResponse(state));
      }
      if (String(url).includes('/estimate-time-entries?') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'logged',
            entriesLogged: 1,
            minutesLogged: 30,
            hasMore: false,
            stoppedReason: 'completed',
            state: estimateState({ initialized: true, revision: 7, loggedMinutes: 120 }),
          }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload([])));
    });
    const user = userEvent.setup();
    renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();

    await user.click(await screen.findByRole('button', { name: 'Review & log 30m' }));
    const dialog = screen.getByRole('dialog', { name: 'Log 30m of new time?' });
    expect(within(dialog).getByText('Current total').nextElementSibling).toHaveTextContent('2h');
    expect(within(dialog).getByText('Already logged').nextElementSibling).toHaveTextContent(
      '1h 30m',
    );
    expect(within(dialog).getByText('To log now').nextElementSibling).toHaveTextContent('30m');
    await user.click(within(dialog).getByRole('button', { name: 'Log 30m' }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes('/estimate-time-entries?') && init?.method === 'POST',
        ),
      ).toBe(true),
    );
    const request = fetchMock.mock.calls.find(
      ([url, init]) => String(url).includes('/estimate-time-entries?') && init?.method === 'POST',
    )!;
    expect((request[1] as RequestInit).body).toBe(
      JSON.stringify({
        scopeKey: 'acme.atlassian.net',
        requestKey: 'generated-operation-id',
        timeZone: resolveEpicTimeZone(),
        estimateTotalMinutes: 120,
        expectedRevision: 5,
        dailySnapshot: [{ activityDate: '2026-08-29', minutes: 120 }],
      }),
    );
  });

  it('previews dated entries exactly as the POST snapshot and submits them', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-logs')) {
        return Promise.resolve(
          jsonResponse(
            estimateSummary({
              totalMinutes: 120,
              directMinutes: 30,
              items: [
                { activityDate: '2026-08-28', agentId: 'agent-1', agentName: 'Coder', minutes: 30 },
                { activityDate: '2026-08-29', agentId: 'agent-1', agentName: 'Coder', minutes: 90 },
              ],
            }),
          ),
        );
      }
      if (String(url).includes('/estimate-log-state?')) {
        return Promise.resolve(jsonResponse(estimateState()));
      }
      if (String(url).includes('/estimate-time-entries?') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'logged',
            entriesLogged: 2,
            minutesLogged: 120,
            hasMore: false,
            stoppedReason: 'completed',
            state: estimateState({ initialized: true, revision: 2, loggedMinutes: 120 }),
          }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload([])));
    });
    const user = userEvent.setup();
    renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();

    await user.click(await screen.findByRole('button', { name: 'Review & log 2h' }));
    const dialog = screen.getByRole('dialog', { name: 'Log 2h of new time?' });
    const firstDate = within(dialog).getByText('Aug 28, 2026').closest('li')!;
    expect(within(firstDate).getByText('30m date total')).toBeVisible();
    expect(within(firstDate).getByText('+30m')).toBeVisible();
    expect(within(firstDate).getByText('1 entry')).toBeVisible();
    const secondDate = within(dialog).getByText('Aug 29, 2026').closest('li')!;
    expect(within(secondDate).getByText('1h 30m date total')).toBeVisible();
    expect(within(secondDate).getByText('+1h 30m')).toBeVisible();
    expect(within(dialog).getByText(/beginning of each local activity date/)).toBeVisible();
    expect(await axe(dialog)).toHaveNoViolations();
    await user.click(within(dialog).getByRole('button', { name: 'Log 2h' }));

    const request = fetchMock.mock.calls.find(
      ([url, init]) => String(url).includes('/estimate-time-entries?') && init?.method === 'POST',
    )!;
    expect((request[1] as RequestInit).body).toBe(
      JSON.stringify({
        scopeKey: 'acme.atlassian.net',
        requestKey: 'generated-operation-id',
        timeZone: resolveEpicTimeZone(),
        estimateTotalMinutes: 120,
        expectedRevision: 0,
        dailySnapshot: [
          { activityDate: '2026-08-28', minutes: 30 },
          { activityDate: '2026-08-29', minutes: 90 },
        ],
      }),
    );
    expect((request[1] as RequestInit).headers).toMatchObject({
      'Idempotency-Key': 'generated-operation-id',
    });
  });

  it('keeps fully credited captured dates visible in a mixed-ledger preview', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-logs')) {
        return Promise.resolve(
          jsonResponse(
            estimateSummary({
              totalMinutes: 120,
              directMinutes: 30,
              items: [
                { activityDate: '2026-08-28', agentId: 'agent-1', agentName: 'Coder', minutes: 30 },
                { activityDate: '2026-08-29', agentId: 'agent-1', agentName: 'Coder', minutes: 90 },
              ],
            }),
          ),
        );
      }
      if (String(url).includes('/estimate-log-state?')) {
        return Promise.resolve(
          jsonResponse(
            estimateState({
              initialized: true,
              revision: 2,
              loggedMinutes: 30,
              aggregationTimeZone: resolveEpicTimeZone(),
              days: [{ activityDate: '2026-08-28', loggedMinutes: 30 }],
              unallocatedLoggedMinutes: 0,
            }),
          ),
        );
      }
      if (String(url).includes('/estimate-time-entries?') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'logged',
            entriesLogged: 1,
            minutesLogged: 90,
            hasMore: false,
            stoppedReason: 'completed',
            state: estimateState({ initialized: true, revision: 3, loggedMinutes: 120 }),
          }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload([])));
    });
    const user = userEvent.setup();
    renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();

    await user.click(await screen.findByRole('button', { name: 'Review & log 1h 30m' }));
    const dialog = screen.getByRole('dialog', { name: 'Log 1h 30m of new time?' });
    // The growing date stays prominent. The fully credited date starts in
    // the compact no-new-time disclosure and remains inspectable.
    const activeDate = within(dialog).getByText('Aug 29, 2026').closest('li')!;
    expect(within(activeDate).getByText('+1h 30m')).toBeVisible();
    expect(within(dialog).queryByText('Aug 28, 2026')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: '1 date has no new time' }));
    expect(within(dialog).getByText('Aug 28, 2026')).toBeVisible();
    expect(within(dialog).getByText('30m date total')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Log 1h 30m' }));

    const request = fetchMock.mock.calls.find(
      ([url, init]) => String(url).includes('/estimate-time-entries?') && init?.method === 'POST',
    )!;
    expect(JSON.parse(String((request[1] as RequestInit).body))).toMatchObject({
      estimateTotalMinutes: 120,
      dailySnapshot: [
        { activityDate: '2026-08-28', minutes: 30 },
        { activityDate: '2026-08-29', minutes: 90 },
      ],
    });
  });

  it('explains the 10-entry cap when one busy date needs more than ten entries', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/time-logs')) {
        return Promise.resolve(
          jsonResponse(
            estimateSummary({
              totalMinutes: 15_000,
              directMinutes: 15_000,
              items: [
                {
                  activityDate: '2026-08-29',
                  agentId: 'agent-1',
                  agentName: 'Coder',
                  minutes: 15_000,
                },
              ],
              taskItems: [
                { epicId: 'epic-root', epicTitle: 'Root task', isDirect: true, minutes: 15_000 },
              ],
            }),
          ),
        );
      }
      if (String(url).includes('/estimate-log-state?')) {
        return Promise.resolve(jsonResponse(estimateState()));
      }
      return Promise.resolve(jsonResponse(historyPayload([])));
    });
    const user = userEvent.setup();
    renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();

    await user.click(await screen.findByRole('button', { name: /Review & log/ }));
    const dialog = screen.getByRole('dialog', { name: 'Log 250h of new time?' });
    const dateRow = within(dialog).getByText('Aug 29, 2026').closest('li')!;
    expect(within(dateRow).getByText('250h date total')).toBeVisible();
    expect(within(dateRow).getByText('+250h')).toBeVisible();
    expect(within(dateRow).getByText('11 entries')).toBeVisible();
    expect(
      within(dialog).getByText(/writes the oldest 10 entries and leaves the remaining 1 unlogged/),
    ).toBeVisible();
    expect(within(dialog).getByText(/One busy date can consume all 10 entries/)).toBeVisible();
  });

  it('offers one-click recapture when the captured snapshot went stale', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-logs')) {
        return Promise.resolve(jsonResponse(estimateSummary()));
      }
      if (String(url).includes('/estimate-log-state?')) {
        return Promise.resolve(jsonResponse(estimateState()));
      }
      if (String(url).includes('/estimate-time-entries?') && init?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({
            message: 'The estimate snapshot is stale; recapture the current estimate.',
            details: { reason: 'estimate_snapshot_stale' },
          }),
        });
      }
      return Promise.resolve(jsonResponse(historyPayload([])));
    });
    const user = userEvent.setup();
    renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();

    await user.click(await screen.findByRole('button', { name: 'Review & log 1h 30m' }));
    await user.click(
      within(screen.getByRole('dialog', { name: /Log .* of new time\?/ })).getByRole('button', {
        name: /^Log /,
      }),
    );

    expect(await screen.findByText(/changed after this confirmation was opened/)).toBeVisible();
    const recapture = screen.getByRole('button', { name: 'Recapture estimate' });
    expect(recapture).toBeVisible();
    // A stale-only case never directs to the destructive rebaseline copy.
    expect(screen.queryByText(/Reconcile logged time/)).toBeNull();
    expect(screen.queryByRole('dialog', { name: /Log .* of new time\?/ })).toBeNull();

    await user.click(recapture);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).includes('/time-logs')).length,
      ).toBeGreaterThanOrEqual(2),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).includes('/estimate-log-state?')).length,
      ).toBeGreaterThanOrEqual(2),
    );
  });

  it('keeps the preview, recapture, and POST on the detail query zone after the browser zone drifts', async () => {
    const mountedZone = resolveEpicTimeZone();
    const driftedZone = mountedZone === 'America/New_York' ? 'Europe/Berlin' : 'America/New_York';
    let createCallCount = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-logs')) {
        return Promise.resolve(jsonResponse(estimateSummary()));
      }
      if (String(url).includes('/estimate-log-state?')) {
        return Promise.resolve(jsonResponse(estimateState()));
      }
      if (String(url).includes('/estimate-time-entries?') && init?.method === 'POST') {
        createCallCount += 1;
        if (createCallCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 400,
            json: async () => ({
              message: 'The estimate snapshot is stale; recapture the current estimate.',
              details: { reason: 'estimate_snapshot_stale' },
            }),
          });
        }
        return Promise.resolve(
          jsonResponse({
            outcome: 'logged',
            entriesLogged: 1,
            minutesLogged: 90,
            hasMore: false,
            stoppedReason: 'completed',
            state: estimateState({ initialized: true, revision: 2, loggedMinutes: 90 }),
          }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload([])));
    });
    let driftSpy: jest.SpyInstance | null = null;
    try {
      const user = userEvent.setup();
      renderBlock({ linkedEpicId: 'epic-root' });
      await openTimeBlock();

      await screen.findByRole('button', { name: 'Review & log 1h 30m' });
      // The detail query mounted before the drift, so its request and every
      // export surface below carry the original zone.
      expect(timeLogUrls()).toHaveLength(1);
      expect(timeLogUrls()[0]).toBe(
        `/api/epics/epic-root/time-logs?timeZone=${encodeURIComponent(mountedZone)}`,
      );

      driftSpy = mockBrowserTimeZone(driftedZone);

      await user.click(screen.getByRole('button', { name: 'Review & log 1h 30m' }));
      await user.click(
        within(screen.getByRole('dialog', { name: /Log .* of new time\?/ })).getByRole('button', {
          name: /^Log /,
        }),
      );

      await waitFor(() => expect(estimateCreateCalls()).toHaveLength(1));
      expect(JSON.parse(estimateCreateCalls()[0][1].body as string).timeZone).toBe(mountedZone);

      // The stale rejection offers a one-click recapture with no reload; the
      // recaptured detail query still runs in the mounted zone.
      expect(await screen.findByText(/changed after this confirmation was opened/)).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Recapture estimate' }));
      await waitFor(() => expect(timeLogUrls().length).toBeGreaterThanOrEqual(2));
      expect(timeLogUrls().at(-1)).toBe(
        `/api/epics/epic-root/time-logs?timeZone=${encodeURIComponent(mountedZone)}`,
      );

      await user.click(await screen.findByRole('button', { name: 'Review & log 1h 30m' }));
      await user.click(
        within(screen.getByRole('dialog', { name: /Log .* of new time\?/ })).getByRole('button', {
          name: /^Log /,
        }),
      );

      await waitFor(() => expect(estimateCreateCalls()).toHaveLength(2));
      expect(JSON.parse(estimateCreateCalls()[1][1].body as string).timeZone).toBe(mountedZone);
    } finally {
      driftSpy?.mockRestore();
    }
  });

  it.each([
    {
      label: 'logged with more dated time remaining',
      response: {
        outcome: 'logged',
        entriesLogged: 10,
        minutesLogged: 600,
        hasMore: true,
        stoppedReason: 'entry_cap',
      },
      expected: 'Oldest 10 entries (10h) logged. More dated estimate time remains unlogged.',
    },
    {
      label: 'partially logged after a provider failure',
      response: {
        outcome: 'partially_logged',
        entriesLogged: 1,
        minutesLogged: 30,
        hasMore: true,
        stoppedReason: 'provider_error',
      },
      expected: 'Confirmed entries were saved (1 entry (30m)); later entries were not sent.',
    },
  ])('announces a $label distinctly', async ({ response, expected }) => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-logs')) {
        return Promise.resolve(jsonResponse(estimateSummary()));
      }
      if (String(url).includes('/estimate-log-state?')) {
        return Promise.resolve(jsonResponse(estimateState()));
      }
      if (String(url).includes('/estimate-time-entries?') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            ...response,
            state: estimateState({ initialized: true, revision: 2, loggedMinutes: 30 }),
          }),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload([])));
    });
    const user = userEvent.setup();
    renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();

    await user.click(await screen.findByRole('button', { name: 'Review & log 1h 30m' }));
    await user.click(
      within(screen.getByRole('dialog', { name: /Log .* of new time\?/ })).getByRole('button', {
        name: /^Log /,
      }),
    );

    expect(await screen.findByRole('status')).toHaveTextContent(expected);
  });

  it('keeps zero new time when the logged checkpoint exceeds the current estimate', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/time-logs')) {
        return Promise.resolve(
          jsonResponse(
            estimateSummary({
              totalMinutes: 60,
              directMinutes: 60,
              items: [
                { activityDate: '2026-08-29', agentId: 'agent-1', agentName: 'Coder', minutes: 60 },
              ],
              taskItems: [
                { epicId: 'epic-root', epicTitle: 'Root task', isDirect: true, minutes: 60 },
              ],
            }),
          ),
        );
      }
      if (String(url).includes('/estimate-log-state?')) {
        return Promise.resolve(
          jsonResponse(
            estimateState({
              initialized: true,
              revision: 4,
              loggedMinutes: 90,
              unallocatedLoggedMinutes: 90,
            }),
          ),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload([])));
    });
    renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();

    expect(await screen.findByText(/no longer matches this estimate/)).toBeVisible();
    expect(screen.getByText(/Use Reconcile logged time to rebuild/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reconcile logged time' })).toBeVisible();
    const panel = screen
      .getByRole('heading', { name: 'DevChain estimated time tracked' })
      .closest('section')!;
    expect(within(panel).getByText('Ready to log').nextElementSibling).toHaveTextContent('0m');
    expect(within(panel).queryByRole('button', { name: /Log new estimate/ })).toBeNull();
  });

  it('reconciles an incompatible logged state without changing the manual draft', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-logs')) {
        return Promise.resolve(jsonResponse(estimateSummary()));
      }
      if (String(url).includes('/estimate-log-state?')) {
        return Promise.resolve(
          jsonResponse(
            estimateState({
              initialized: true,
              revision: 4,
              loggedMinutes: 120,
              unallocatedLoggedMinutes: 120,
            }),
          ),
        );
      }
      if (init?.method === 'PUT') {
        return Promise.resolve(
          jsonResponse(estimateState({ initialized: true, revision: 1, loggedMinutes: 30 })),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload([])));
    });
    const user = userEvent.setup();
    renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();
    await user.type(screen.getByLabelText('Duration'), '15m');
    await user.type(screen.getByLabelText('Note (optional)'), 'Keep this draft');

    const trigger = await screen.findByRole('button', { name: 'Reconcile logged time' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Reconcile logged time' });
    expect(within(dialog).getByLabelText('Logged minutes to recognize')).toHaveValue(120);
    expect(
      within(dialog).getByText(/Lowering the value can submit duplicate remote time/),
    ).toBeVisible();
    await user.clear(within(dialog).getByLabelText('Logged minutes to recognize'));
    await user.type(within(dialog).getByLabelText('Logged minutes to recognize'), '-1');
    await user.click(within(dialog).getByRole('button', { name: 'Save reconciliation' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/nonnegative whole number/);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
    await user.clear(within(dialog).getByLabelText('Logged minutes to recognize'));
    await user.type(within(dialog).getByLabelText('Logged minutes to recognize'), '30');
    expect(await axe(document.body)).toHaveNoViolations();
    await user.click(within(dialog).getByRole('button', { name: 'Save reconciliation' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Reconcile logged time' })).toBeNull(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.getByLabelText('Duration')).toHaveValue('15m');
    expect(screen.getByLabelText('Note (optional)')).toHaveValue('Keep this draft');
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect((put[1] as RequestInit).body).toBe(
      JSON.stringify({
        scopeKey: 'acme.atlassian.net',
        loggedMinutes: 30,
        expectedRevision: 4,
        timeZone: resolveEpicTimeZone(),
      }),
    );
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/estimate-time-entries')),
    ).toBe(false);
  });

  it('blocks manual writes and exposes honest manual recovery for durable pending state', async () => {
    const pendingState = estimateState({
      initialized: true,
      revision: 2,
      pendingDisposition: 'manual_review',
      pending: {
        operationId: 'estimate-pending-1',
        deltaMinutes: 30,
        estimateTotalMinutes: 120,
        startedAt: '2026-08-30T10:00:00.000Z',
        phase: 'prepared',
        resolution: null,
      },
    });
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/time-logs')) {
        return Promise.resolve(jsonResponse(estimateSummary()));
      }
      if (String(url).includes('/estimate-log-state?')) {
        return Promise.resolve(jsonResponse(pendingState));
      }
      if (String(url).includes('/time-entries?')) {
        return Promise.resolve(jsonResponse(historyPayload([entry()])));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    renderBlock({ linkedEpicId: 'epic-root' });
    await openHistory();

    expect(await screen.findByText('Estimate submission needs review')).toBeVisible();
    expect(screen.getByText(/unavailable after restart or connection replacement/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Mark logged' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Mark not logged' })).toBeEnabled();
    expect(screen.getByRole('link', { name: /Open in source/ })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Log time' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Reconcile logged time' })).toBeNull();
    expect(await screen.findByRole('button', { name: /Delete 1h entry started/ })).toBeDisabled();
  });

  it('shows Verify only for a pending operation whose current epoch permits it', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/time-logs')) {
        return Promise.resolve(jsonResponse(estimateSummary()));
      }
      if (String(url).includes('/estimate-log-state?')) {
        return Promise.resolve(
          jsonResponse(
            estimateState({
              initialized: true,
              revision: 2,
              pendingDisposition: 'outcome_unknown',
              canVerify: true,
              pending: {
                operationId: 'estimate-pending-1',
                deltaMinutes: 30,
                estimateTotalMinutes: 120,
                startedAt: '2026-08-30T10:00:00.000Z',
                phase: 'outcome_unknown',
                resolution: null,
              },
            }),
          ),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload([])));
    });
    renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();

    expect(await screen.findByRole('button', { name: 'Verify' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Mark logged' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Mark not logged' })).toBeVisible();
  });

  it('renders a stored finishing choice without offering a second resolution', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/time-logs')) {
        return Promise.resolve(jsonResponse(estimateSummary()));
      }
      if (String(url).includes('/estimate-log-state?')) {
        return Promise.resolve(
          jsonResponse(
            estimateState({
              initialized: true,
              revision: 3,
              pendingDisposition: 'finishing',
              pending: {
                operationId: 'estimate-pending-1',
                deltaMinutes: 30,
                estimateTotalMinutes: 120,
                startedAt: '2026-08-30T10:00:00.000Z',
                phase: 'outcome_unknown',
                resolution: 'logged',
              },
            }),
          ),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload([])));
    });
    renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();

    expect(await screen.findByText('Finishing estimate resolution')).toBeVisible();
    expect(screen.getByText('Saved choice: Mark logged.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Mark logged' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark not logged' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Log time' })).toBeDisabled();
  });

  it('resets an open estimate confirmation when the operation scope changes', async () => {
    serveEstimate(estimateSummary());
    const user = userEvent.setup();
    const { rerenderBlock } = renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();
    await user.click(await screen.findByRole('button', { name: 'Review & log 1h 30m' }));
    expect(screen.getByRole('dialog', { name: /Log .* of new time\?/ })).toBeVisible();

    rerenderBlock({ connectionEpoch: 'connection-jira-b:5' });

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Log .* of new time\?/ })).toBeNull(),
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
          canEdit: false,
          canDelete: false,
          note: 'x'.repeat(10_000) + 'more',
          noteTruncated: true,
          durationMs: 1_800_000,
        }),
      ]),
    );
    renderBlock();
    await openHistory();

    expect(screen.getByText('Last 30 days')).toBeVisible();
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveClass('grid', 'min-w-0');
    expect(within(rows[0]!).getByText('Duration')).toHaveClass('sm:sr-only');
    expect(within(rows[0]!).getByText('Started')).toHaveClass('sm:sr-only');
    expect(within(rows[0]!).getByText('Note')).toHaveClass('sm:sr-only');
    expect(within(rows[0]!).getByText('1h')).toBeVisible();
    expect(within(rows[0]!).getByText(/2026/)).toBeVisible();
    expect(within(rows[0]!).getByText('Implementation')).toBeVisible();
    expect(within(rows[0]!).getByRole('button', { name: /Edit 1h entry started/ })).toBeVisible();
    expect(within(rows[0]!).getByRole('button', { name: /Delete 1h entry started/ })).toBeVisible();
    // Foreign or non-editable/non-deletable entries receive no mutation affordance.
    expect(within(rows[1]!).queryByRole('button', { name: /Edit/ })).toBeNull();
    expect(within(rows[1]!).queryByRole('button', { name: /Delete/ })).toBeNull();
    expect(within(rows[1]!).getByText(/note was shortened/)).toBeVisible();
  });

  it('edits an owned remote entry without changing the DevChain checkpoint', async () => {
    serveHistory(historyPayload([entry()]));
    const user = userEvent.setup();
    renderBlock();
    await openHistory();

    await user.click(await screen.findByRole('button', { name: /Edit 1h entry started/ }));
    const dialog = screen.getByRole('dialog', { name: 'Edit time entry' });
    expect(dialog).toHaveTextContent(
      "This changes the provider entry only. DevChain's Already logged value will not change.",
    );
    const durationInput = within(dialog).getByLabelText('Duration');
    await user.clear(durationInput);
    await user.type(durationInput, '1h 30m');
    const noteInput = within(dialog).getByLabelText('Note (optional)');
    await user.clear(noteInput);
    await user.type(noteInput, 'Updated remotely');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit time entry' })).toBeNull(),
    );
    const updateCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).includes('/time-entries/10001?') && init?.method === 'PUT',
    );
    expect(updateCall).toBeDefined();
    expect(JSON.parse(String((updateCall![1] as RequestInit).body))).toMatchObject({
      durationMs: 5_400_000,
      note: 'Updated remotely',
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/estimate-log-state'))).toBe(
      false,
    );
  });

  it('hides cached rows again when history closes', async () => {
    serveHistory(historyPayload([entry()]));
    const user = userEvent.setup();
    const { container } = renderBlock();
    await openHistory();

    await waitFor(() => expect(container.querySelector('li[data-entry-id]')).not.toBeNull());
    await user.click(screen.getByLabelText('Recent time entries'));

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
    expect(screen.getByLabelText('Recent time entries').closest('details')).not.toHaveAttribute(
      'open',
    );
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
      expect(screen.getByLabelText('Recent time entries').closest('details')).not.toHaveAttribute(
        'open',
      ),
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
            String(url).includes('/time-entries?') && (init as RequestInit).method === 'POST',
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
        ([url, init]) => String(url).includes('/time-entries?') && !init?.method,
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
      if (String(url).includes('/time-entries?') && !init?.method) {
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
          receipt: {
            operationId: 'op-1',
            phase: 'outcome_unknown',
            canVerify: true,
            expiresAt: futureReceiptIso(),
          },
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
      if (String(url).includes('/time-entries?') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            outcome: 'outcome_unknown',
            receipt: {
              operationId: 'op-epoch',
              phase: 'outcome_unknown',
              canVerify: true,
              expiresAt: futureReceiptIso(),
            },
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
    expect(screen.getByRole('button', { name: 'Verify' })).toBeVisible();

    rerenderBlock({ connectionEpoch: 'connection-jira-b:5' });
    await openTimeBlock();

    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
    expect(screen.getByRole('link', { name: /Open in source/ })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Acknowledge duplicate risk' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Log time' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Acknowledge duplicate risk' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Log time' })).toBeEnabled());
  });

  it('hides Verify for an unprovable unknown create and directs to the source and acknowledgement', async () => {
    serveHistory(historyPayload([]));
    const user = userEvent.setup();
    renderBlock();
    await openTimeBlock();

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-entries?') && !init?.method) {
        return Promise.resolve(jsonResponse(historyPayload([])));
      }
      if (init?.method === 'POST' && String(url).includes('/acknowledge')) {
        return Promise.resolve(
          jsonResponse({ operationId: 'op-unprovable', phase: 'abandoned_unknown' }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          outcome: 'outcome_unknown',
          receipt: {
            operationId: 'op-unprovable',
            phase: 'outcome_unknown',
            canVerify: false,
            expiresAt: futureReceiptIso(),
          },
        }),
      );
    });

    await user.type(screen.getByLabelText('Duration'), '15m');
    await user.click(screen.getByRole('button', { name: 'Log time' }));

    expect(await screen.findByText('Last submission unconfirmed')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
    expect(screen.getByText(/cannot be verified automatically/)).toBeVisible();
    expect(screen.getByRole('link', { name: /Open in source/ })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Acknowledge duplicate risk' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Log time' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Acknowledge duplicate risk' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Log time' })).toBeEnabled());
  });

  it('hides Verify once the receipt expires but keeps the unknown write lock and recovery', async () => {
    serveHistory(historyPayload([]));
    const user = userEvent.setup();
    renderBlock();
    await openTimeBlock();

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-entries?') && !init?.method) {
        return Promise.resolve(jsonResponse(historyPayload([])));
      }
      if (init?.method === 'POST' && String(url).includes('/acknowledge')) {
        return Promise.resolve(
          jsonResponse({ operationId: 'op-expired', phase: 'abandoned_unknown' }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          outcome: 'outcome_unknown',
          receipt: {
            operationId: 'op-expired',
            phase: 'outcome_unknown',
            canVerify: true,
            expiresAt: '2020-01-01T00:00:00.000Z',
          },
        }),
      );
    });

    await user.type(screen.getByLabelText('Duration'), '15m');
    await user.click(screen.getByRole('button', { name: 'Log time' }));

    expect(await screen.findByText('Last submission unconfirmed')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
    expect(screen.getByRole('link', { name: /Open in source/ })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Acknowledge duplicate risk' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Log time' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Acknowledge duplicate risk' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Log time' })).toBeEnabled());
  });

  it('directs estimate recovery to the source and manual marks when Verify is unsupported', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/time-logs')) {
        return Promise.resolve(jsonResponse(estimateSummary()));
      }
      if (String(url).includes('/estimate-log-state?')) {
        return Promise.resolve(
          jsonResponse(
            estimateState({
              initialized: true,
              revision: 2,
              pendingDisposition: 'outcome_unknown',
              canVerify: false,
              pending: {
                operationId: 'estimate-pending-2',
                deltaMinutes: 30,
                estimateTotalMinutes: 120,
                startedAt: '2026-08-30T10:00:00.000Z',
                phase: 'outcome_unknown',
                resolution: null,
                activityDate: '2026-08-29',
              },
            }),
          ),
        );
      }
      return Promise.resolve(jsonResponse(historyPayload([])));
    });
    renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();

    expect(await screen.findByText('Estimate submission needs review')).toBeVisible();
    expect(screen.getByText(/cannot confirm whether the estimate entry was created/)).toBeVisible();
    expect(screen.getByText(/30m on 2026-08-29/)).toBeVisible();
    expect(screen.getByText(/Open the entry in the source and check it/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Mark logged' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Mark not logged' })).toBeVisible();
    expect(screen.getByRole('link', { name: /Open in source/ })).toBeVisible();
  });

  it('removes estimate Verify at the receipt deadline and keeps the manual marks', async () => {
    const deadline = Date.now() + 300;
    const pendingView = estimateState({
      initialized: true,
      revision: 2,
      pendingDisposition: 'outcome_unknown',
      canVerify: true,
      verifyExpiresAt: new Date(deadline).toISOString(),
      pending: {
        operationId: 'estimate-pending-3',
        deltaMinutes: 30,
        estimateTotalMinutes: 120,
        startedAt: '2026-08-30T10:00:00.000Z',
        phase: 'outcome_unknown',
        resolution: null,
      },
    });
    const manualReviewView = estimateState({
      initialized: true,
      revision: 2,
      pendingDisposition: 'manual_review',
      canVerify: false,
      verifyExpiresAt: null,
      pending: {
        operationId: 'estimate-pending-3',
        deltaMinutes: 30,
        estimateTotalMinutes: 120,
        startedAt: '2026-08-30T10:00:00.000Z',
        phase: 'outcome_unknown',
        resolution: null,
      },
    });
    let stateServed = 0;
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/time-logs')) {
        return Promise.resolve(jsonResponse(estimateSummary()));
      }
      if (String(url).includes('/estimate-log-state?')) {
        stateServed += 1;
        return Promise.resolve(jsonResponse(stateServed === 1 ? pendingView : manualReviewView));
      }
      return Promise.resolve(jsonResponse(historyPayload([])));
    });
    renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();

    expect(await screen.findByRole('button', { name: 'Verify' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Mark logged' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Mark not logged' })).toBeVisible();

    // One receipt-absolute deadline transition flips the mounted panel to
    // server-derived manual review; Verify disappears, the marks remain.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull(), {
      timeout: 2_000,
    });
    expect(screen.getByText(/unavailable after restart or connection replacement/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Mark logged' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Mark not logged' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Log time' })).toBeDisabled();

    // No polling: exactly one deadline refetch.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stateFetches = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/estimate-log-state?'),
    );
    expect(stateFetches).toHaveLength(2);
  });

  it('keeps estimate Verify expired when the deadline refetch fails', async () => {
    const deadline = Date.now() + 300;
    const pendingView = estimateState({
      initialized: true,
      revision: 2,
      pendingDisposition: 'outcome_unknown',
      canVerify: true,
      verifyExpiresAt: new Date(deadline).toISOString(),
      pending: {
        operationId: 'estimate-pending-refetch-failure',
        deltaMinutes: 30,
        estimateTotalMinutes: 120,
        startedAt: '2026-08-30T10:00:00.000Z',
        phase: 'outcome_unknown',
        resolution: null,
      },
    });
    let stateFetches = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-logs')) {
        return Promise.resolve(jsonResponse(estimateSummary()));
      }
      if (String(url).includes('/estimate-log-state?')) {
        stateFetches += 1;
        return stateFetches === 1
          ? Promise.resolve(jsonResponse(pendingView))
          : Promise.reject(new Error('checkpoint unavailable'));
      }
      if (init?.method) {
        return Promise.reject(new Error('provider mutation must not run'));
      }
      return Promise.resolve(jsonResponse(historyPayload([])));
    });
    renderBlock({ linkedEpicId: 'epic-root' });
    await openTimeBlock();

    expect(await screen.findByRole('button', { name: 'Verify' })).toBeVisible();

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull(), {
      timeout: 2_000,
    });
    expect(
      screen.getByText(
        'The estimate checkpoint is unavailable. Time writes are locked until it reloads.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Mark logged' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Mark not logged' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Log time' })).toBeDisabled();
    expect(fetchMock.mock.calls.some(([, init]) => Boolean(init?.method))).toBe(false);
    expect(stateFetches).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stateFetches).toBe(2);
  });

  it('unlocks the manual form after receipt expiry through the displayed acknowledge action', async () => {
    serveHistory(historyPayload([]));
    const user = userEvent.setup();
    renderBlock();
    await openTimeBlock();

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/time-entries?') && !init?.method) {
        return Promise.resolve(jsonResponse(historyPayload([])));
      }
      if (String(url).includes('/acknowledge')) {
        // The server receipt is gone after expiry; this endpoint must never
        // be called by the expiry-safe path.
        return Promise.reject(new Error('impossible server acknowledgement'));
      }
      return Promise.resolve(
        jsonResponse({
          outcome: 'outcome_unknown',
          receipt: {
            operationId: 'op-settled',
            phase: 'outcome_unknown',
            canVerify: true,
            expiresAt: '2020-01-01T00:00:00.000Z',
          },
        }),
      );
    });

    await user.type(screen.getByLabelText('Duration'), '15m');
    await user.click(screen.getByRole('button', { name: 'Log time' }));

    expect(await screen.findByText('Last submission unconfirmed')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Log time' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Acknowledge duplicate risk' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Log time' })).toBeEnabled());
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/acknowledge'))).toBe(false);
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
            String(url).includes('/time-entries/10001?') &&
            (init as RequestInit).method === 'DELETE',
        ),
      ).toBe(true);
    });
    // Focus lands on the next remaining row's first mutation affordance.
    await waitFor(() => {
      expect(document.activeElement?.dataset.entryEdit).toBeDefined();
      expect(document.activeElement?.textContent).toBe('Edit');
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
    expect(screen.queryByText('Last 30 days')).toBeNull();
  });

  it('has no axe violations in the form and expanded history', async () => {
    serveHistory(historyPayload([entry()]));
    const { container } = renderBlock();
    await openHistory();

    await waitFor(() => expect(screen.getByText('Implementation')).toBeVisible());
    expect(await axe(container)).toHaveNoViolations();
  });
});
