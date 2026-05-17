import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ScheduleEditorDialog } from './ScheduleEditorDialog';
import type { ScheduledEpic } from '@/ui/lib/scheduled-epics';

const toastSpy = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

jest.mock('@/ui/components/shared/TimezoneSelector', () => ({
  getDetectedTimezone: () => 'America/New_York',
  TimezoneSelector: ({
    value,
    onChange,
    'aria-label': ariaLabel,
  }: {
    value: string;
    onChange: (tz: string) => void;
    variant?: string;
    'aria-label'?: string;
  }) => (
    <button
      type="button"
      aria-label={ariaLabel ?? 'Select timezone'}
      data-testid="timezone-selector"
      data-value={value}
      onClick={() => onChange('Europe/London')}
    >
      {value}
    </button>
  ),
}));

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function makeSchedule(overrides: Partial<ScheduledEpic> = {}): ScheduledEpic {
  return {
    id: 'sched-1',
    projectId: 'proj-1',
    name: 'Daily Standup',
    cronExpression: '0 9 * * *',
    timezone: 'UTC',
    enabled: true,
    titleTemplate: 'Standup {{date}}',
    descriptionTemplate: null,
    templateStatusId: null,
    templateParentEpicId: null,
    templateAgentId: null,
    templateTags: ['daily'],
    allowOverlap: false,
    missedRunPolicy: 'skip',
    configVersion: 3,
    runCount: null,
    nextRunAt: '2026-06-01T09:00:00.000Z',
    lastRunAt: null,
    lastRunStatus: null,
    lastError: null,
    createdAt: '2026-05-16T00:00:00.000Z',
    updatedAt: '2026-05-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('ScheduleEditorDialog', () => {
  let fetchMock: jest.Mock;

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
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = jest.fn();
    }

    fetchMock = jest.fn(async (url: string) => {
      if (url.includes('/api/statuses')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'status-1',
                projectId: 'proj-1',
                label: 'To Do',
                color: '#3b82f6',
                position: 0,
                createdAt: '',
                updatedAt: '',
              },
              {
                id: 'status-2',
                projectId: 'proj-1',
                label: 'In Progress',
                color: '#f59e0b',
                position: 1,
                createdAt: '',
                updatedAt: '',
              },
            ],
          }),
        };
      }
      if (url.includes('/api/agents')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'agent-1', projectId: 'proj-1', profileId: 'profile-1', name: 'Coder (1)' },
              { id: 'agent-2', projectId: 'proj-1', profileId: 'profile-2', name: 'Reviewer (1)' },
            ],
          }),
        };
      }
      if (url.includes('/api/epics') && url.includes('q=')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'epic-1',
                projectId: 'proj-1',
                title: 'Sprint Epic',
                parentId: null,
                statusId: 'status-1',
                version: 1,
                agentId: null,
                tags: [],
                description: null,
                createdAt: '',
                updatedAt: '',
              },
              {
                id: 'epic-sub',
                projectId: 'proj-1',
                title: 'Sub Epic',
                parentId: 'epic-1',
                statusId: 'status-1',
                version: 1,
                agentId: null,
                tags: [],
                description: null,
                createdAt: '',
                updatedAt: '',
              },
            ],
          }),
        };
      }
      if (url.match(/\/api\/epics\/[0-9a-f-]{36}$/)) {
        return {
          ok: true,
          json: async () => ({
            id: '11111111-2222-3333-4444-555555555555',
            projectId: 'proj-1',
            title: 'Resolved Parent',
            parentId: null,
            statusId: 'status-1',
            version: 1,
            agentId: null,
            tags: [],
            description: null,
            createdAt: '',
            updatedAt: '',
          }),
        };
      }
      if (url.includes('/api/scheduled-epics')) {
        return { ok: true, json: async () => makeSchedule() };
      }
      return { ok: true, json: async () => ({}) };
    }) as jest.Mock;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = fetchMock;
  });

  describe('create mode', () => {
    it('renders with empty fields for create', () => {
      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );
      expect(screen.getByText('Create Schedule')).toBeInTheDocument();
      expect(screen.getByLabelText('Name')).toHaveValue('');
    });

    it('defaults timezone to detected timezone', () => {
      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );
      const tzSelector = screen.getByTestId('timezone-selector');
      expect(tzSelector).toHaveAttribute('data-value', 'America/New_York');
    });

    it('shows validation errors when submitting empty form', async () => {
      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Create' }));

      await waitFor(() => {
        expect(screen.getByText('Name is required')).toBeInTheDocument();
        expect(screen.getByText('Title template is required')).toBeInTheDocument();
      });
    });

    it('does not corrupt form state after validation error', async () => {
      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );

      const nameInput = screen.getByLabelText('Name');
      fireEvent.change(nameInput, { target: { value: 'My Schedule' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));

      await waitFor(() => {
        expect(screen.getByText('Title template is required')).toBeInTheDocument();
      });
      expect(nameInput).toHaveValue('My Schedule');
    });

    it('submits create with correct payload including null sentinels', async () => {
      const onOpenChange = jest.fn();
      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={onOpenChange} projectId="proj-1" />,
      );

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My Sched' } });
      fireEvent.change(screen.getByLabelText('Title Template'), {
        target: { value: 'Sprint {{date}}' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/scheduled-epics',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('"name":"My Sched"'),
          }),
        );
      });

      const createCall = fetchMock.mock.calls.find(
        (c: string[]) => c[0] === '/api/scheduled-epics' && c[1]?.method === 'POST',
      );
      const body = JSON.parse(createCall[1].body);
      expect(body.templateStatusId).toBeNull();
      expect(body.templateAgentId).toBeNull();
      expect(body.templateParentEpicId).toBeNull();
    });

    it('submits selected status ID in create payload', async () => {
      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading statuses...')).not.toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test' } });
      fireEvent.change(screen.getByLabelText('Title Template'), {
        target: { value: 'Test {{date}}' },
      });

      // Open status select and pick "In Progress"
      fireEvent.click(screen.getByRole('combobox', { name: /Default Status/ }));
      await waitFor(() => {
        expect(screen.getByText('In Progress')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('In Progress'));

      fireEvent.click(screen.getByRole('button', { name: 'Create' }));

      await waitFor(() => {
        const createCall = fetchMock.mock.calls.find(
          (c: string[]) => c[0] === '/api/scheduled-epics' && c[1]?.method === 'POST',
        );
        expect(createCall).toBeDefined();
        const body = JSON.parse(createCall[1].body);
        expect(body.templateStatusId).toBe('status-2');
      });
    });

    it('submits selected agent ID in create payload', async () => {
      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading agents...')).not.toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test' } });
      fireEvent.change(screen.getByLabelText('Title Template'), {
        target: { value: 'Test {{date}}' },
      });

      fireEvent.click(screen.getByRole('combobox', { name: /Default Agent/ }));
      await waitFor(() => {
        expect(screen.getByText('Coder (1)')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('Coder (1)'));

      fireEvent.click(screen.getByRole('button', { name: 'Create' }));

      await waitFor(() => {
        const createCall = fetchMock.mock.calls.find(
          (c: string[]) => c[0] === '/api/scheduled-epics' && c[1]?.method === 'POST',
        );
        expect(createCall).toBeDefined();
        const body = JSON.parse(createCall[1].body);
        expect(body.templateAgentId).toBe('agent-1');
      });
    });
  });

  describe('edit mode', () => {
    it('renders with populated fields for edit', () => {
      const schedule = makeSchedule({ name: 'Existing', titleTemplate: 'Existing {{date}}' });
      renderWithQuery(
        <ScheduleEditorDialog
          open={true}
          onOpenChange={jest.fn()}
          schedule={schedule}
          projectId="proj-1"
        />,
      );
      expect(screen.getByText('Edit Schedule')).toBeInTheDocument();
      expect(screen.getByLabelText('Name')).toHaveValue('Existing');
    });

    it('submits update with configVersion in payload', async () => {
      const schedule = makeSchedule({ configVersion: 5 });
      renderWithQuery(
        <ScheduleEditorDialog
          open={true}
          onOpenChange={jest.fn()}
          schedule={schedule}
          projectId="proj-1"
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Update' }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/scheduled-epics/sched-1',
          expect.objectContaining({
            method: 'PUT',
            body: expect.stringContaining('"configVersion":5'),
          }),
        );
      });
    });

    it('shows version conflict toast on 409', async () => {
      fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
        if (url === '/api/scheduled-epics/sched-1' && opts?.method === 'PUT') {
          return {
            ok: false,
            status: 409,
            json: async () => ({ message: 'Version conflict' }),
          };
        }
        if (url.includes('/api/statuses')) {
          return { ok: true, json: async () => ({ items: [] }) };
        }
        if (url.includes('/api/agents')) {
          return { ok: true, json: async () => ({ items: [] }) };
        }
        return { ok: true, json: async () => ({}) };
      });

      const schedule = makeSchedule();
      renderWithQuery(
        <ScheduleEditorDialog
          open={true}
          onOpenChange={jest.fn()}
          schedule={schedule}
          projectId="proj-1"
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Update' }));

      await waitFor(() => {
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Version conflict' }),
        );
      });
    });

    it('resolves saved status ID into display value', async () => {
      const schedule = makeSchedule({ templateStatusId: 'status-2' });
      renderWithQuery(
        <ScheduleEditorDialog
          open={true}
          onOpenChange={jest.fn()}
          schedule={schedule}
          projectId="proj-1"
        />,
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading statuses...')).not.toBeInTheDocument();
      });

      const statusTrigger = screen.getByRole('combobox', { name: /Default Status/ });
      expect(statusTrigger).toHaveTextContent('In Progress');
    });

    it('resolves saved agent ID into display value', async () => {
      const schedule = makeSchedule({ templateAgentId: 'agent-1' });
      renderWithQuery(
        <ScheduleEditorDialog
          open={true}
          onOpenChange={jest.fn()}
          schedule={schedule}
          projectId="proj-1"
        />,
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading agents...')).not.toBeInTheDocument();
      });

      const agentTrigger = screen.getByRole('combobox', { name: /Default Agent/ });
      expect(agentTrigger).toHaveTextContent('Coder (1)');
    });

    it('shows unresolved status fallback for unknown UUID', async () => {
      const schedule = makeSchedule({ templateStatusId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
      renderWithQuery(
        <ScheduleEditorDialog
          open={true}
          onOpenChange={jest.fn()}
          schedule={schedule}
          projectId="proj-1"
        />,
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading statuses...')).not.toBeInTheDocument();
      });

      const statusTrigger = screen.getByRole('combobox', { name: /Default Status/ });
      expect(statusTrigger).toHaveTextContent(/Unavailable: aaaaaaaa/);
    });

    it('shows unresolved agent fallback for unknown UUID', async () => {
      const schedule = makeSchedule({ templateAgentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
      renderWithQuery(
        <ScheduleEditorDialog
          open={true}
          onOpenChange={jest.fn()}
          schedule={schedule}
          projectId="proj-1"
        />,
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading agents...')).not.toBeInTheDocument();
      });

      const agentTrigger = screen.getByRole('combobox', { name: /Default Agent/ });
      expect(agentTrigger).toHaveTextContent(/Unavailable: aaaaaaaa/);
    });

    it('preserves unresolved UUID on save unless explicitly cleared', async () => {
      const schedule = makeSchedule({
        templateStatusId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        templateAgentId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
        templateParentEpicId: 'cccccccc-dddd-eeee-ffff-000000000000',
      });
      renderWithQuery(
        <ScheduleEditorDialog
          open={true}
          onOpenChange={jest.fn()}
          schedule={schedule}
          projectId="proj-1"
        />,
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading statuses...')).not.toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Update' }));

      await waitFor(() => {
        const updateCall = fetchMock.mock.calls.find(
          (c: string[]) => c[0] === '/api/scheduled-epics/sched-1' && c[1]?.method === 'PUT',
        );
        expect(updateCall).toBeDefined();
        const body = JSON.parse(updateCall[1].body);
        expect(body.templateStatusId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
        expect(body.templateAgentId).toBe('bbbbbbbb-cccc-dddd-eeee-ffffffffffff');
        expect(body.templateParentEpicId).toBe('cccccccc-dddd-eeee-ffff-000000000000');
      });
    });

    it('clears status to null via Project default selection', async () => {
      const schedule = makeSchedule({ templateStatusId: 'status-1' });
      renderWithQuery(
        <ScheduleEditorDialog
          open={true}
          onOpenChange={jest.fn()}
          schedule={schedule}
          projectId="proj-1"
        />,
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading statuses...')).not.toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('combobox', { name: /Default Status/ }));
      await waitFor(() => {
        expect(screen.getByText('Project default')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('Project default'));

      fireEvent.click(screen.getByRole('button', { name: 'Update' }));

      await waitFor(() => {
        const updateCall = fetchMock.mock.calls.find(
          (c: string[]) => c[0] === '/api/scheduled-epics/sched-1' && c[1]?.method === 'PUT',
        );
        expect(updateCall).toBeDefined();
        const body = JSON.parse(updateCall[1].body);
        expect(body.templateStatusId).toBeNull();
      });
    });
  });

  describe('template variable insertion', () => {
    it('has Insert Variable controls for title and description', () => {
      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );

      const insertButtons = screen.getAllByRole('button', { name: 'Insert variable' });
      expect(insertButtons).toHaveLength(2);
    });

    it('inserts variable token into title template', async () => {
      const user = userEvent.setup();
      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );

      const titleInput = screen.getByLabelText('Title Template');
      await user.type(titleInput, 'Sprint ');

      const insertButtons = screen.getAllByRole('button', { name: 'Insert variable' });
      await user.click(insertButtons[0]);

      await waitFor(() => {
        expect(screen.getByText('{{schedule_name}}')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('{{schedule_name}}'));

      await waitFor(() => {
        expect(titleInput).toHaveValue('Sprint {{schedule_name}}');
      });
    });

    it('inserts variable token into description template', async () => {
      const user = userEvent.setup();
      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );

      const descInput = screen.getByLabelText('Description Template (optional)');
      await user.type(descInput, 'Created on ');

      const insertButtons = screen.getAllByRole('button', { name: 'Insert variable' });
      await user.click(insertButtons[1]);

      await waitFor(() => {
        const dateButtons = screen.getAllByText('{{date}}');
        expect(dateButtons.length).toBeGreaterThan(0);
      });
      const dateButtons = screen.getAllByText('{{date}}');
      fireEvent.click(dateButtons[dateButtons.length - 1]);

      await waitFor(() => {
        expect(descInput).toHaveValue('Created on {{date}}');
      });
    });

    it('advertises only supported runner variables', async () => {
      const user = userEvent.setup();
      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );

      const insertButtons = screen.getAllByRole('button', { name: 'Insert variable' });
      await user.click(insertButtons[0]);

      await waitFor(() => {
        expect(screen.getByText('{{schedule_name}}')).toBeInTheDocument();
        expect(screen.getByText('{{date}}')).toBeInTheDocument();
        expect(screen.getByText('{{datetime}}')).toBeInTheDocument();
        expect(screen.getByText('{{timestamp}}')).toBeInTheDocument();
        expect(screen.getByText('{{run_source}}')).toBeInTheDocument();
        expect(screen.getByText('{{project_id}}')).toBeInTheDocument();
      });
    });
  });

  describe('parent epic picker', () => {
    it('filters out sub-epics from search results', async () => {
      const user = userEvent.setup();
      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );

      const parentTrigger = screen.getByRole('combobox', { name: 'Select parent epic' });
      await user.click(parentTrigger);

      const searchInput = await screen.findByLabelText('Search parent epics');
      await user.type(searchInput, 'Sprint');

      await waitFor(() => {
        expect(screen.getByText('Sprint Epic')).toBeInTheDocument();
        expect(screen.queryByText('Sub Epic')).not.toBeInTheDocument();
      });
    });

    it('does not navigate routes on selection', async () => {
      const user = userEvent.setup();
      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );

      const parentTrigger = screen.getByRole('combobox', { name: 'Select parent epic' });
      await user.click(parentTrigger);

      const searchInput = await screen.findByLabelText('Search parent epics');
      await user.type(searchInput, 'Sprint');

      await waitFor(() => {
        expect(screen.getByText('Sprint Epic')).toBeInTheDocument();
      });
      await user.click(screen.getByText('Sprint Epic'));

      // After selection, dialog is still open - no navigation happened
      expect(screen.getByText('Create Schedule')).toBeInTheDocument();
    });

    it('submits selected parent epic ID in payload', async () => {
      const user = userEvent.setup();
      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading statuses...')).not.toBeInTheDocument();
      });

      const parentTrigger = screen.getByRole('combobox', { name: 'Select parent epic' });
      await user.click(parentTrigger);

      const searchInput = await screen.findByLabelText('Search parent epics');
      await user.type(searchInput, 'Sprint');

      await waitFor(() => {
        expect(screen.getByText('Sprint Epic')).toBeInTheDocument();
      });
      await user.click(screen.getByText('Sprint Epic'));

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test' } });
      fireEvent.change(screen.getByLabelText('Title Template'), {
        target: { value: 'Test {{date}}' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));

      await waitFor(() => {
        const createCall = fetchMock.mock.calls.find(
          (c: string[]) => c[0] === '/api/scheduled-epics' && c[1]?.method === 'POST',
        );
        expect(createCall).toBeDefined();
        const body = JSON.parse(createCall[1].body);
        expect(body.templateParentEpicId).toBe('epic-1');
      });
    });

    it('submits null for no parent sentinel', async () => {
      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading statuses...')).not.toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test' } });
      fireEvent.change(screen.getByLabelText('Title Template'), {
        target: { value: 'Test' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));

      await waitFor(() => {
        const createCall = fetchMock.mock.calls.find(
          (c: string[]) => c[0] === '/api/scheduled-epics' && c[1]?.method === 'POST',
        );
        expect(createCall).toBeDefined();
        const body = JSON.parse(createCall[1].body);
        expect(body.templateParentEpicId).toBeNull();
      });
    });

    it('resolves existing parent epic in edit mode', async () => {
      const schedule = makeSchedule({
        templateParentEpicId: '11111111-2222-3333-4444-555555555555',
      });
      renderWithQuery(
        <ScheduleEditorDialog
          open={true}
          onOpenChange={jest.fn()}
          schedule={schedule}
          projectId="proj-1"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText('Resolved Parent')).toBeInTheDocument();
      });
    });

    it('ArrowDown moves selection to next result', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/api/epics') && url.includes('q=')) {
          return {
            ok: true,
            json: async () => ({
              items: [
                {
                  id: 'epic-a',
                  projectId: 'proj-1',
                  title: 'Alpha Epic',
                  parentId: null,
                  statusId: 's1',
                  version: 1,
                  agentId: null,
                  tags: [],
                  description: null,
                  createdAt: '',
                  updatedAt: '',
                },
                {
                  id: 'epic-b',
                  projectId: 'proj-1',
                  title: 'Beta Epic',
                  parentId: null,
                  statusId: 's1',
                  version: 1,
                  agentId: null,
                  tags: [],
                  description: null,
                  createdAt: '',
                  updatedAt: '',
                },
              ],
            }),
          };
        }
        if (url.includes('/api/statuses')) return { ok: true, json: async () => ({ items: [] }) };
        if (url.includes('/api/agents')) return { ok: true, json: async () => ({ items: [] }) };
        return { ok: true, json: async () => ({}) };
      });

      const user = userEvent.setup();
      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );

      const parentTrigger = screen.getByRole('combobox', { name: 'Select parent epic' });
      await user.click(parentTrigger);

      const searchInput = await screen.findByLabelText('Search parent epics');
      await user.type(searchInput, 'Epic');

      await waitFor(() => {
        expect(screen.getByText('Alpha Epic')).toBeInTheDocument();
        expect(screen.getByText('Beta Epic')).toBeInTheDocument();
      });

      // First result starts selected (index 0)
      const alphaButton = screen.getByText('Alpha Epic').closest('button')!;
      expect(alphaButton.className).toContain('bg-accent');

      // ArrowDown moves to second
      fireEvent.keyDown(searchInput, { key: 'ArrowDown' });
      const betaButton = screen.getByText('Beta Epic').closest('button')!;
      expect(betaButton.className).toContain('bg-accent');
    });

    it('Enter selects the highlighted result without navigating', async () => {
      const user = userEvent.setup();
      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );

      const parentTrigger = screen.getByRole('combobox', { name: 'Select parent epic' });
      await user.click(parentTrigger);

      const searchInput = await screen.findByLabelText('Search parent epics');
      await user.type(searchInput, 'Sprint');

      await waitFor(() => {
        expect(screen.getByText('Sprint Epic')).toBeInTheDocument();
      });

      fireEvent.keyDown(searchInput, { key: 'Enter' });

      // Dialog still open (no navigation), picker closed, value set
      expect(screen.getByText('Create Schedule')).toBeInTheDocument();
      // The parent trigger now shows the selected epic title via resolution
      // The form state should now hold 'epic-1'
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test' } });
      fireEvent.change(screen.getByLabelText('Title Template'), { target: { value: 'T' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));

      await waitFor(() => {
        const createCall = fetchMock.mock.calls.find(
          (c: string[]) => c[0] === '/api/scheduled-epics' && c[1]?.method === 'POST',
        );
        expect(createCall).toBeDefined();
        const body = JSON.parse(createCall[1].body);
        expect(body.templateParentEpicId).toBe('epic-1');
      });
    });

    it('Escape closes the picker without selecting', async () => {
      const user = userEvent.setup();
      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );

      const parentTrigger = screen.getByRole('combobox', { name: 'Select parent epic' });
      await user.click(parentTrigger);

      const searchInput = await screen.findByLabelText('Search parent epics');
      await user.type(searchInput, 'Sprint');

      await waitFor(() => {
        expect(screen.getByText('Sprint Epic')).toBeInTheDocument();
      });

      fireEvent.keyDown(searchInput, { key: 'Escape' });

      // Picker closes - search input disappears
      await waitFor(() => {
        expect(screen.queryByLabelText('Search parent epics')).not.toBeInTheDocument();
      });

      // Value should still be "No parent" (nothing selected)
      expect(parentTrigger).toHaveTextContent('No parent');
    });

    it('shows search error when query fails', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/api/epics') && url.includes('q=')) {
          return { ok: false, status: 500, json: async () => ({ message: 'Server error' }) };
        }
        if (url.includes('/api/statuses')) return { ok: true, json: async () => ({ items: [] }) };
        if (url.includes('/api/agents')) return { ok: true, json: async () => ({ items: [] }) };
        return { ok: true, json: async () => ({}) };
      });

      const user = userEvent.setup();
      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );

      const parentTrigger = screen.getByRole('combobox', { name: 'Select parent epic' });
      await user.click(parentTrigger);

      const searchInput = await screen.findByLabelText('Search parent epics');
      await user.type(searchInput, 'fail');

      await waitFor(() => {
        expect(screen.getByText('Search failed. Please try again.')).toBeInTheDocument();
      });
    });
  });

  describe('query error handling', () => {
    it('shows error message when statuses query fails', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/api/statuses')) {
          throw new Error('Network error');
        }
        if (url.includes('/api/agents')) return { ok: true, json: async () => ({ items: [] }) };
        return { ok: true, json: async () => ({}) };
      });

      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );

      await waitFor(() => {
        expect(
          screen.getByText('Failed to load statuses. Existing selection is preserved.'),
        ).toBeInTheDocument();
      });
    });

    it('shows error message when agents query fails', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/api/agents')) {
          throw new Error('Network error');
        }
        if (url.includes('/api/statuses')) return { ok: true, json: async () => ({ items: [] }) };
        return { ok: true, json: async () => ({}) };
      });

      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );

      await waitFor(() => {
        expect(
          screen.getByText('Failed to load agents. Existing selection is preserved.'),
        ).toBeInTheDocument();
      });
    });

    it('does not block submit when status query fails but existing value is preserved', async () => {
      fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
        if (url.includes('/api/statuses')) {
          throw new Error('Network error');
        }
        if (url.includes('/api/agents')) return { ok: true, json: async () => ({ items: [] }) };
        if (url.includes('/api/scheduled-epics') && opts?.method === 'POST') {
          return { ok: true, json: async () => ({}) };
        }
        return { ok: true, json: async () => ({}) };
      });

      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );

      await waitFor(() => {
        expect(
          screen.getByText('Failed to load statuses. Existing selection is preserved.'),
        ).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test' } });
      fireEvent.change(screen.getByLabelText('Title Template'), {
        target: { value: 'Test' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));

      await waitFor(() => {
        const createCall = fetchMock.mock.calls.find(
          (c: string[]) => c[0] === '/api/scheduled-epics' && c[1]?.method === 'POST',
        );
        expect(createCall).toBeDefined();
      });
    });
  });

  describe('agent filtering', () => {
    it('filters out guest agents from options', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/api/agents')) {
          return {
            ok: true,
            json: async () => ({
              items: [
                { id: 'agent-1', projectId: 'proj-1', profileId: 'profile-1', name: 'Real Agent' },
                {
                  id: 'guest-1',
                  projectId: 'proj-1',
                  profileId: null,
                  name: 'Guest User',
                  type: 'guest',
                },
              ],
            }),
          };
        }
        if (url.includes('/api/statuses')) {
          return { ok: true, json: async () => ({ items: [] }) };
        }
        return { ok: true, json: async () => ({}) };
      });

      renderWithQuery(
        <ScheduleEditorDialog open={true} onOpenChange={jest.fn()} projectId="proj-1" />,
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading agents...')).not.toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('combobox', { name: /Default Agent/ }));
      await waitFor(() => {
        expect(screen.getByText('Real Agent')).toBeInTheDocument();
        expect(screen.queryByText('Guest User')).not.toBeInTheDocument();
      });
    });
  });
});
