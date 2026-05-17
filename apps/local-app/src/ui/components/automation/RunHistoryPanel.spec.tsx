import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { RunHistoryPanel } from './RunHistoryPanel';
import type { ScheduledEpicRun, ScheduledEpicRunsPage } from '@/ui/lib/scheduled-epics';

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const baseRun: ScheduledEpicRun = {
  id: 'run-1',
  scheduleId: 'sched-1',
  plannedFor: '2026-05-17T09:00:00.000Z',
  source: 'scheduler',
  status: 'completed',
  createdEpicId: null,
  startedAt: '2026-05-17T09:00:05.000Z',
  finishedAt: '2026-05-17T09:01:00.000Z',
  errorMessage: null,
  createdAt: '2026-05-17T09:00:00.000Z',
  updatedAt: '2026-05-17T09:01:00.000Z',
};

function makeRunsPage(overrides: Partial<ScheduledEpicRun> = {}): ScheduledEpicRunsPage {
  return { items: [{ ...baseRun, ...overrides }], total: 1, limit: 10, offset: 0 };
}

function mockFetch(page: ScheduledEpicRunsPage) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = jest.fn(async () => ({
    ok: true,
    json: async () => page,
  }));
}

beforeEach(() => {
  mockFetch(makeRunsPage());
});

describe('RunHistoryPanel', () => {
  it('shows loading state initially', () => {
    renderWithProviders(<RunHistoryPanel scheduleId="sched-1" />);
    expect(screen.getByText('Loading history…')).toBeInTheDocument();
  });

  it('shows completed status badge', async () => {
    renderWithProviders(<RunHistoryPanel scheduleId="sched-1" />);
    await screen.findByText('completed');
    expect(screen.getByText('completed')).toBeInTheDocument();
  });

  it('shows scheduler source badge', async () => {
    renderWithProviders(<RunHistoryPanel scheduleId="sched-1" />);
    await screen.findByText('completed');
    expect(screen.getByText('Scheduler')).toBeInTheDocument();
  });

  it('shows manual source badge', async () => {
    mockFetch(makeRunsPage({ source: 'manual' }));
    renderWithProviders(<RunHistoryPanel scheduleId="sched-1" />);
    await screen.findByText('completed');
    expect(screen.getByText('Manual')).toBeInTheDocument();
  });

  it('shows failed status badge', async () => {
    mockFetch(makeRunsPage({ status: 'failed', errorMessage: 'timeout' }));
    renderWithProviders(<RunHistoryPanel scheduleId="sched-1" />);
    await screen.findByText('failed');
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('shows skipped status badge', async () => {
    mockFetch(makeRunsPage({ status: 'skipped' }));
    renderWithProviders(<RunHistoryPanel scheduleId="sched-1" />);
    await screen.findByText('skipped');
    expect(screen.getByText('skipped')).toBeInTheDocument();
  });

  it('shows running status badge', async () => {
    mockFetch(
      makeRunsPage({ status: 'running', startedAt: '2026-05-17T09:00:05.000Z', finishedAt: null }),
    );
    renderWithProviders(<RunHistoryPanel scheduleId="sched-1" />);
    await screen.findByText('running');
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('shows planned time', async () => {
    renderWithProviders(<RunHistoryPanel scheduleId="sched-1" />);
    await screen.findByText('completed');
    expect(screen.getByText(/Planned:/)).toBeInTheDocument();
  });

  it('shows started time when available', async () => {
    renderWithProviders(<RunHistoryPanel scheduleId="sched-1" />);
    await screen.findByText('completed');
    expect(screen.getByText(/Started:/)).toBeInTheDocument();
  });

  it('shows finished time when available', async () => {
    renderWithProviders(<RunHistoryPanel scheduleId="sched-1" />);
    await screen.findByText('completed');
    expect(screen.getByText(/Finished:/)).toBeInTheDocument();
  });

  it('shows lag when start time is available', async () => {
    renderWithProviders(<RunHistoryPanel scheduleId="sched-1" />);
    await screen.findByText('completed');
    expect(screen.getByText(/Lag:/)).toBeInTheDocument();
  });

  it('shows created epic link when epicId is present', async () => {
    mockFetch(makeRunsPage({ createdEpicId: 'abcdef12-0000-0000-0000-000000000000' }));
    renderWithProviders(<RunHistoryPanel scheduleId="sched-1" />);
    await screen.findByText('completed');
    expect(screen.getByText(/Epic abcdef12/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Epic abcdef12/ });
    expect(link).toHaveAttribute('href', '/epics/abcdef12-0000-0000-0000-000000000000');
  });

  it('does not show epic link when epicId is null', async () => {
    renderWithProviders(<RunHistoryPanel scheduleId="sched-1" />);
    await screen.findByText('completed');
    expect(screen.queryByText(/Epic /)).not.toBeInTheDocument();
  });

  it('shows show error button for failed runs', async () => {
    mockFetch(makeRunsPage({ status: 'failed', errorMessage: 'connection refused' }));
    renderWithProviders(<RunHistoryPanel scheduleId="sched-1" />);
    await screen.findByText('failed');
    expect(screen.getByText('Show error')).toBeInTheDocument();
  });

  it('expands error message on click', async () => {
    mockFetch(makeRunsPage({ status: 'failed', errorMessage: 'connection refused' }));
    renderWithProviders(<RunHistoryPanel scheduleId="sched-1" />);
    await screen.findByText('Show error');
    await userEvent.click(screen.getByText('Show error'));
    expect(screen.getByText('connection refused')).toBeInTheDocument();
    expect(screen.getByText('Hide error')).toBeInTheDocument();
  });

  it('shows no runs message when list is empty', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ items: [], total: 0, limit: 10, offset: 0 }),
    }));
    renderWithProviders(<RunHistoryPanel scheduleId="sched-1" />);
    await screen.findByText('No runs recorded yet.');
  });

  it('shows error state on API failure', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ message: 'Internal error' }),
    }));
    renderWithProviders(<RunHistoryPanel scheduleId="sched-1" />);
    await screen.findByText('Internal error');
  });

  it('shows pagination when there are multiple pages', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        items: [baseRun],
        total: 25,
        limit: 10,
        offset: 0,
      }),
    }));
    renderWithProviders(<RunHistoryPanel scheduleId="sched-1" />);
    await screen.findByText('completed');
    expect(screen.getByText('Page 1 of 3 (25 total)')).toBeInTheDocument();
  });

  it('does not show pagination for single page', async () => {
    renderWithProviders(<RunHistoryPanel scheduleId="sched-1" />);
    await screen.findByText('completed');
    expect(screen.queryByText(/Page 1 of/)).not.toBeInTheDocument();
  });
});
