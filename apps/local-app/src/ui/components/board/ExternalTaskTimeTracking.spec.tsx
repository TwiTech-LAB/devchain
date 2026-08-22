import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
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

function renderBlock(props: Partial<React.ComponentProps<typeof ExternalTaskTimeTracking>> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ExternalTaskTimeTracking
        provider="jira"
        taskId="ENG-1"
        connectionEpoch={connectionEpoch}
        enabled
        identityAccepted
        timeTrackingEnabled
        taskTotalDurationMs={5_400_000}
        sourceUrl="https://acme.atlassian.net/browse/ENG-1"
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

async function openExpanded(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByText('Time tracked', { selector: 'summary' }));
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

  it('shows the task total in the collapsed summary', () => {
    serveHistory(historyPayload([]));
    renderBlock();

    const summary = screen.getByText('Time tracked', { selector: 'summary' }).closest('details');
    expect(summary).toHaveTextContent('1h 30m');
    expect(summary?.open).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the total visible when the history request fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
    renderBlock();
    await openExpanded();

    const block = screen.getByText('Time tracked', { selector: 'summary' }).closest('details')!;
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
    await openExpanded();

    expect(screen.getByText('Your entries · last 30 days')).toBeVisible();
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('1h')).toBeVisible();
    expect(within(rows[0]!).getByText(/2026/)).toBeVisible();
    expect(within(rows[0]!).getByText('Implementation')).toBeVisible();
    expect(within(rows[0]!).getByRole('button', { name: 'Delete' })).toBeVisible();
    // Foreign or non-deletable entries never receive a Delete affordance.
    expect(within(rows[1]!).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(rows[1]!).getByText(/note was shortened/)).toBeVisible();
  });

  it('renders incomplete and running-timer notices plus the empty state', async () => {
    serveHistory(historyPayload([], { truncated: true, hasRunningTimer: true }));
    renderBlock();
    await openExpanded();

    expect(
      screen.getByText('Incomplete list — the provider did not return the full 30-day window.'),
    ).toBeVisible();
    expect(screen.getByText('A running timer is active in the provider.')).toBeVisible();
    expect(screen.getByText('No entries in the last 30 days.')).toBeVisible();
  });

  it('shows unavailable copy when the provider lacks the log_time capability', async () => {
    renderBlock({ timeTrackingEnabled: false, taskTotalDurationMs: null });
    await openExpanded();

    expect(screen.getByText('Time tracking is unavailable.')).toBeVisible();
    expect(screen.queryByLabelText('Duration')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid durations locally without a request', async () => {
    serveHistory(historyPayload([]));
    const user = userEvent.setup();
    renderBlock();
    await openExpanded();

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
    await openExpanded();

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
  });

  it('uses the optional exact start behind the disclosure', async () => {
    serveHistory(historyPayload([]));
    const user = userEvent.setup();
    renderBlock();
    await openExpanded();

    expect(screen.queryByLabelText('Started at')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Add exact start time/ }));
    expect(screen.getByLabelText('Started at')).toBeVisible();

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
    await openExpanded();

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

  it('confirms deletion naming duration and date, warns about the remote entry, and refocuses the next row', async () => {
    serveHistory(
      historyPayload([
        entry({ remoteId: '10001' }),
        entry({ remoteId: '10002', durationMs: 1_800_000 }),
      ]),
    );
    const user = userEvent.setup();
    renderBlock();
    await openExpanded();

    const firstRow = screen.getAllByRole('listitem')[0]!;
    await user.click(within(firstRow).getByRole('button', { name: 'Delete' }));

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
    await openExpanded();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
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
    await openExpanded();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
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
    await openExpanded();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
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
    await openExpanded();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
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
    await openExpanded();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
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
    await openExpanded();

    // First entry's delete rejects.
    const rows = screen.getAllByRole('listitem');
    await user.click(within(rows[0]!).getByRole('button', { name: 'Delete' }));
    let dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete entry' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/nope/i);

    // Cancel out, then open the second entry: the stale error must be gone.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(within(rows[1]!).getByRole('button', { name: 'Delete' }));
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

  it('has no axe violations in the expanded block', async () => {
    serveHistory(historyPayload([entry()]));
    const { container } = renderBlock();
    await openExpanded();

    await waitFor(() => expect(screen.getByText('Implementation')).toBeVisible());
    expect(await axe(container)).toHaveNoViolations();
  });
});
