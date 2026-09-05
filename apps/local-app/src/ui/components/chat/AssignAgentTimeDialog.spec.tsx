import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe } from 'jest-axe';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AssignAgentTimeDialog, type AssignAgentTimeTarget } from './AssignAgentTimeDialog';

// Layer: component unit. The dialog's freeze/refresh/submit contract is pure
// over the fetch factory, so mocking fetch is the cheapest reliable layer.
const fetchMock = jest.fn();

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

const EPIC_ID = '44444444-4444-4444-8444-444444444444';

function makeTarget(overrides: Partial<AssignAgentTimeTarget> = {}): AssignAgentTimeTarget {
  return {
    agentId: 'agent-1',
    agentName: 'Alpha',
    capturedAt: '2026-09-01T00:00:00.000Z',
    snapshotToken: 'a'.repeat(64),
    durationMs: 300_000,
    minutes: 5,
    segmentCount: 2,
    oldestActivityAt: '2026-09-01T00:00:00.000Z',
    newestActivityAt: '2026-09-01T00:05:00.000Z',
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

function seedReads(bufferPayload: unknown = null): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/epics?')) {
      return jsonResponse({
        items: [
          {
            id: EPIC_ID,
            title: 'Ship the API',
            statusId: 'status-1',
            updatedAt: '2026-09-01T00:00:00.000Z',
          },
        ],
      });
    }
    if (url.startsWith('/api/statuses?')) {
      return jsonResponse({
        items: [{ id: 'status-1', label: 'In Progress', color: '#3b82f6' }],
      });
    }
    if (url.startsWith('/api/agent-time-buffers?')) {
      return jsonResponse(
        bufferPayload ?? {
          capturedAt: '2026-09-01T00:00:00.000Z',
          items: [
            {
              agentId: 'agent-1',
              snapshotToken: 'a'.repeat(64),
              minutes: 5,
              durationMs: 300_000,
              segmentCount: 2,
              oldestActivityAt: '2026-09-01T00:00:00.000Z',
              newestActivityAt: '2026-09-01T00:05:00.000Z',
            },
          ],
        },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function renderDialog(
  target: AssignAgentTimeTarget | null,
  onSuccess: (
    target: AssignAgentTimeTarget,
    epic: { id: string; title: string },
  ) => void = jest.fn(),
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <AssignAgentTimeDialog
        open={target !== null}
        projectId="project-1"
        target={target}
        onCancel={jest.fn()}
        onSuccess={onSuccess}
      />
    </QueryClientProvider>,
  );
  return { ...utils, client, onSuccess };
}

describe('AssignAgentTimeDialog', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    seedReads();
  });

  it('renders the compact structure with only the approved copy', async () => {
    renderDialog(makeTarget());

    expect(screen.getByText('Log time to an Epic.')).toBeInTheDocument();
    expect(screen.getByText('5m from Alpha.')).toBeInTheDocument();
    expect(
      screen.getByText(
        'DevChain assigns time automatically when it can. Use this dialog for time that remains unassigned.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('Search by title, DevChain ID, Jira key, or ClickUp ID.'),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Ship the API/ })).toBeInTheDocument();
    });
    const row = screen.getByRole('option', { name: /Ship the API/ });
    expect(row).toHaveTextContent('In Progress');
    expect(row).toHaveTextContent(EPIC_ID.slice(0, 8));

    expect(fetchMock).toHaveBeenCalledWith('/api/epics?projectId=project-1&limit=20&type=active', {
      signal: expect.any(AbortSignal),
    });
  });

  it('requires an explicit selection before the exact footer confirm is enabled', async () => {
    renderDialog(makeTarget());

    const confirm = await screen.findByRole('button', { name: 'Log 5m.' });
    expect(confirm).toBeDisabled();

    fireEvent.click(await screen.findByRole('option', { name: /Ship the API/ }));
    expect(confirm).toBeEnabled();
  });

  it('submits the exact frozen snapshot and reports success', async () => {
    const onSuccess = jest.fn();
    const target = makeTarget();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/api/agent-time-buffers/${encodeURIComponent(target.agentId)}/assign`)) {
        expect(JSON.parse(String(init?.body))).toEqual({
          projectId: 'project-1',
          targetEpicId: EPIC_ID,
          capturedAt: target.capturedAt,
          snapshotToken: target.snapshotToken,
        });
        return jsonResponse({ workspaceId: 'workspace-1' });
      }
      if (url.startsWith('/api/epics?') || url.startsWith('/api/statuses?')) {
        return jsonResponse(
          url.startsWith('/api/epics?')
            ? {
                items: [
                  { id: EPIC_ID, title: 'Ship the API', statusId: 'status-1', updatedAt: 'x' },
                ],
              }
            : { items: [{ id: 'status-1', label: 'In Progress', color: null }] },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    renderDialog(target, onSuccess);
    fireEvent.click(await screen.findByRole('option', { name: /Ship the API/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Log 5m.' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    const [reportedTarget, reportedEpic] = onSuccess.mock.calls[0];
    expect(reportedTarget).toEqual(target);
    expect(reportedEpic).toEqual({ id: EPIC_ID, title: 'Ship the API' });
  });

  it('keeps the dialog open on 409, refreshes the frozen snapshot, and never retries', async () => {
    let assignCalls = 0;
    const target = makeTarget();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/assign')) {
        assignCalls += 1;
        return jsonResponse({ code: 'conflict' }, 409);
      }
      if (url.startsWith('/api/agent-time-buffers?')) {
        return jsonResponse({
          capturedAt: '2026-09-01T00:10:00.000Z',
          items: [
            {
              agentId: 'agent-1',
              snapshotToken: 'c'.repeat(64),
              minutes: 8,
              durationMs: 480_000,
              segmentCount: 3,
              oldestActivityAt: '2026-09-01T00:00:00.000Z',
              newestActivityAt: '2026-09-01T00:10:00.000Z',
            },
          ],
        });
      }
      if (url.startsWith('/api/epics?')) {
        return jsonResponse({
          items: [{ id: EPIC_ID, title: 'Ship the API', statusId: 'status-1', updatedAt: 'x' }],
        });
      }
      if (url.startsWith('/api/statuses?')) {
        return jsonResponse({ items: [{ id: 'status-1', label: 'In Progress', color: null }] });
      }
      void init;
      throw new Error(`Unexpected fetch: ${url}`);
    });

    renderDialog(target);
    fireEvent.click(await screen.findByRole('option', { name: /Ship the API/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Log 5m.' }));

    await waitFor(() => {
      expect(screen.getByText('8m from Alpha.')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Log 8m.' })).toBeInTheDocument();
    expect(screen.getByText(/Buffered time changed since this dialog opened/i)).toBeInTheDocument();
    expect(assignCalls).toBe(1);

    // The refreshed confirmation needs a fresh explicit selection; the write
    // itself never auto-retries.
    await Promise.resolve();
    expect(assignCalls).toBe(1);
  });

  it('keeps the frozen confirmation when the caller re-renders with poll-side updates', async () => {
    const target = makeTarget();
    const { rerender } = renderDialog(target);

    await screen.findByRole('option', { name: /Ship the API/ });
    // Same identity (agentId + capturedAt) but mutated content, as a changed
    // object reference would be: the open confirmation must not move.
    const drifted = makeTarget({ minutes: 99, durationMs: 99 * 60_000 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={client}>
        <AssignAgentTimeDialog
          open
          projectId="project-1"
          target={drifted}
          onCancel={jest.fn()}
          onSuccess={jest.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText('5m from Alpha.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log 5m.' })).toBeInTheDocument();
  });

  it('searches with the debounced query string', async () => {
    renderDialog(makeTarget());
    await screen.findByRole('option', { name: /Ship the API/ });

    fireEvent.change(screen.getByRole('textbox', { name: 'Search Epics' }), {
      target: { value: 'PROJ-42' },
    });
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).includes('q=PROJ-42')),
    ).toHaveLength(0);

    // Real timers: the debounce fires after 300ms and the query follows.
    await waitFor(
      () => {
        expect(fetchMock.mock.calls.some(([input]) => String(input).includes('q=PROJ-42'))).toBe(
          true,
        );
      },
      { timeout: 2000 },
    );
  });

  it('keeps the dialog open on a 409 with nothing left to assign and blocks resubmission', async () => {
    let assignCalls = 0;
    const target = makeTarget();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/assign')) {
        assignCalls += 1;
        return jsonResponse({ code: 'conflict' }, 409);
      }
      if (url.startsWith('/api/agent-time-buffers?')) {
        // The refresh finds nothing left: empty set, null watermark.
        return jsonResponse({ capturedAt: null, items: [] });
      }
      if (url.startsWith('/api/epics?')) {
        return jsonResponse({
          items: [{ id: EPIC_ID, title: 'Ship the API', statusId: 'status-1', updatedAt: 'x' }],
        });
      }
      if (url.startsWith('/api/statuses?')) {
        return jsonResponse({ items: [{ id: 'status-1', label: 'In Progress', color: null }] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    renderDialog(target);
    fireEvent.click(await screen.findByRole('option', { name: /Ship the API/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Log 5m.' }));

    await waitFor(() => {
      expect(screen.getByText(/That time was already assigned elsewhere/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('Log time to an Epic.')).toBeInTheDocument();

    // The prior selection cleared and assignment stays disabled even after a
    // fresh explicit pick: the stale snapshot is unresubmittable.
    const confirm = screen.getByRole('button', { name: 'Log 5m.' });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole('option', { name: /Ship the API/ }));
    expect(confirm).toBeDisabled();

    fireEvent.click(confirm);
    await Promise.resolve();
    expect(assignCalls).toBe(1);
  });

  it('stays axe-clean with the picker open and a row selected', async () => {
    const { container } = renderDialog(makeTarget());

    fireEvent.click(await screen.findByRole('option', { name: /Ship the API/ }));
    expect(await axe(container)).toHaveNoViolations();
  });
});
