import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ScheduledEpicsTab } from './ScheduledEpicsTab';
import type { ScheduledEpic } from '@/ui/lib/scheduled-epics';

const toastSpy = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({ selectedProjectId: 'project-1' }),
}));

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const baseSchedule: ScheduledEpic = {
  id: 'sched-1',
  projectId: 'project-1',
  name: 'Weekly sync',
  cronExpression: '0 9 * * 1',
  timezone: 'UTC',
  enabled: true,
  titleTemplate: 'Weekly sync {{date}}',
  descriptionTemplate: null,
  templateStatusId: null,
  templateParentEpicId: null,
  templateAgentId: null,
  templateTags: [],
  allowOverlap: false,
  missedRunPolicy: 'skip',
  configVersion: 1,
  runCount: 7,
  nextRunAt: '2026-05-18T09:00:00.000Z',
  lastRunAt: '2026-05-11T09:00:01.000Z',
  lastRunStatus: 'completed',
  lastError: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  toastSpy.mockReset();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!(global as any).ResizeObserver) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/scheduled-epics?')) {
      return { ok: true, json: async () => [baseSchedule] } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
});

describe('ScheduledEpicsTab', () => {
  it('shows schedule cadence, timezone, status and actions', async () => {
    renderWithQuery(<ScheduledEpicsTab />);
    await screen.findByText('Weekly sync');
    {
      expect(screen.getByText('Weekly sync')).toBeInTheDocument();
    }
    {
      expect(screen.getByText('0 9 * * 1')).toBeInTheDocument();
    }
    {
      expect(screen.getByText('UTC')).toBeInTheDocument();
    }
    {
      expect(screen.getByText('Runs: 7')).toBeInTheDocument();
    }
    {
      expect(screen.getByText('completed')).toBeInTheDocument();
    }
    {
      expect(screen.getByText('Enabled')).toBeInTheDocument();
    }
    {
      expect(screen.getByText('Run now')).toBeInTheDocument();
    }
  });

  it('shows — for null run count', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => [{ ...baseSchedule, runCount: null }],
    }));
    renderWithQuery(<ScheduledEpicsTab />);
    await screen.findByText('Weekly sync');
    expect(screen.getByText('Runs: —')).toBeInTheDocument();
  });

  it.each([
    {
      label: 'opens the create dialog from the empty-state Add Schedule button',
      buttonName: 'Add Schedule',
    },
    {
      label: 'opens the create dialog from the empty-state Create Schedule button',
      buttonName: 'Create Schedule',
    },
  ] as const)('$label', async ({ buttonName }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => [],
    }));

    renderWithQuery(<ScheduledEpicsTab />);
    await screen.findByText('No schedules yet');

    await userEvent.click(screen.getByRole('button', { name: buttonName }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('');
  });

  it('shows error state on API failure', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ message: 'Server error' }),
    }));
    renderWithQuery(<ScheduledEpicsTab />);
    await screen.findByText('Server error');
    expect(screen.getByText('Server error')).toBeInTheDocument();
  });
});

describe('ScheduledEpicsTab — toggle interaction', () => {
  it('calls toggle API when the enable switch is clicked', async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/scheduled-epics?')) {
        return { ok: true, json: async () => [baseSchedule] } as Response;
      }
      if (url.includes('/toggle') && (init as RequestInit)?.method === 'POST') {
        return { ok: true, json: async () => ({ ...baseSchedule, enabled: false }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = fetchMock;

    renderWithQuery(<ScheduledEpicsTab />);
    await screen.findByText('Weekly sync');

    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/scheduled-epics/sched-1/toggle',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('shows conflict toast when toggle returns 409', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/scheduled-epics?')) {
        return { ok: true, json: async () => [baseSchedule] } as Response;
      }
      if (url.includes('/toggle') && (init as RequestInit)?.method === 'POST') {
        return {
          ok: false,
          status: 409,
          json: async () => ({ message: 'Version conflict' }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    renderWithQuery(<ScheduledEpicsTab />);
    await screen.findByText('Weekly sync');

    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Conflict' }));
    });
  });
});

describe('ScheduledEpicsTab — run-now action', () => {
  it.each([
    {
      label: 'shows Run started toast when run is claimed',
      runStatus: 'completed',
      claimed: true,
      toastTitle: 'Run started',
    },
    {
      label: 'shows Already running toast when run is not claimed',
      runStatus: 'running',
      claimed: false,
      toastTitle: 'Already running',
    },
  ] as const)('$label', async ({ runStatus, claimed, toastTitle }) => {
    const baseRun = { id: 'run-1', scheduleId: 'sched-1', status: runStatus };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/scheduled-epics?')) {
        return { ok: true, json: async () => [baseSchedule] } as Response;
      }
      if (url.includes('/run-now') && (init as RequestInit)?.method === 'POST') {
        return { ok: true, json: async () => ({ claimed: claimed, run: baseRun }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    renderWithQuery(<ScheduledEpicsTab />);
    await screen.findByText('Weekly sync');

    fireEvent.click(screen.getByTitle('Run now'));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: toastTitle }));
    });
  });

  it('shows error toast when run-now API fails', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/scheduled-epics?')) {
        return { ok: true, json: async () => [baseSchedule] } as Response;
      }
      if (url.includes('/run-now') && (init as RequestInit)?.method === 'POST') {
        return {
          ok: false,
          status: 500,
          json: async () => ({ message: 'Run trigger failed' }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    renderWithQuery(<ScheduledEpicsTab />);
    await screen.findByText('Weekly sync');

    fireEvent.click(screen.getByTitle('Run now'));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Error', variant: 'destructive' }),
      );
    });
  });
});

describe('ScheduledEpicsTab — delete flow', () => {
  it('calls delete API and shows Deleted toast on confirmation', async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/scheduled-epics?')) {
        return { ok: true, json: async () => [baseSchedule] } as Response;
      }
      if (url === '/api/scheduled-epics/sched-1' && (init as RequestInit)?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = fetchMock;

    renderWithQuery(<ScheduledEpicsTab />);
    await screen.findByText('Weekly sync');

    const dropdownTrigger = document.querySelector('[aria-haspopup="menu"]') as HTMLElement;
    await userEvent.click(dropdownTrigger);
    await userEvent.click(await screen.findByText('Delete'));

    await screen.findByText('Delete Schedule');

    // Click the destructive Delete button in the dialog footer
    const deleteButtons = screen.getAllByRole('button', { name: /^delete$/i });
    await userEvent.click(deleteButtons[deleteButtons.length - 1]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/scheduled-epics/sched-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Deleted' }));
    });
  });

  it('dismisses the confirmation dialog when Cancel is clicked', async () => {
    renderWithQuery(<ScheduledEpicsTab />);
    await screen.findByText('Weekly sync');

    const dropdownTrigger = document.querySelector('[aria-haspopup="menu"]') as HTMLElement;
    await userEvent.click(dropdownTrigger);
    await userEvent.click(await screen.findByText('Delete'));

    await screen.findByText('Delete Schedule');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByText('Delete Schedule')).not.toBeInTheDocument();
    });
  });
});
