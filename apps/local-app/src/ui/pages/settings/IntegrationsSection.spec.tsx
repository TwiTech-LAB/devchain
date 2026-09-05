import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { IntegrationConnectionDirectory } from '@/ui/lib/integration-connections';
import type { ManagedSubtaskSyncHealth } from '@/ui/lib/managed-subtask-sync';
import { IntegrationConnectionApiError } from '@/ui/hooks/useIntegrationConnections';
import { IntegrationsSection } from './IntegrationsSection';

const activateProjectMock = jest.fn();
const navigateMock = jest.fn();
const useAvailabilityMock = jest.fn();
const useDirectoryMock = jest.fn();
const useLegacyActionsMock = jest.fn();
const useLegacyHealthMock = jest.fn();
const assignMock = jest.fn();
const disconnectMock = jest.fn();

jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

jest.mock('@/ui/hooks/useIntegrationAvailability', () => ({
  useIntegrationAvailability: () => useAvailabilityMock(),
}));

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    selectedProjectId: '11111111-1111-4111-8111-111111111111',
    activateProject: activateProjectMock,
  }),
}));

jest.mock('@/ui/hooks/useIntegrationConnectionDirectory', () => ({
  useIntegrationConnectionDirectory: () => useDirectoryMock(),
  useLegacyIntegrationConnectionActions: () => useLegacyActionsMock(),
  useLegacyManagedSubtaskSyncHealth: (connectionId: string) => useLegacyHealthMock(connectionId),
}));

const directoryWith = (
  overrides: Partial<IntegrationConnectionDirectory> = {},
): IntegrationConnectionDirectory => ({
  items: [
    {
      project: { id: '11111111-1111-4111-8111-111111111111', name: 'Product' },
      workspace: { id: '44444444-4444-4444-8444-444444444444', name: 'Main' },
      provider: 'clickup',
      configured: true,
      updatedAt: '2026-08-20T10:30:00.000Z',
      subtaskSyncEnabled: true,
      hasMigratedSharedOrigin: false,
    },
    {
      project: { id: '11111111-1111-4111-8111-111111111111', name: 'Product' },
      workspace: { id: '44444444-4444-4444-8444-444444444444', name: 'Main' },
      provider: 'jira',
      configured: false,
      updatedAt: null,
      subtaskSyncEnabled: false,
      hasMigratedSharedOrigin: false,
    },
  ],
  unassignedConnections: [],
  truncated: false,
  ...overrides,
});

const legacyActionsValue = () => ({
  assign: assignMock,
  disconnect: disconnectMock,
  assigningConnectionId: null,
  disconnectingConnectionId: null,
});

function legacyHealthValue(
  overrides: Partial<ManagedSubtaskSyncHealth> = {},
): ManagedSubtaskSyncHealth {
  return {
    provider: 'jira',
    enabled: true,
    syncSettingRevision: 1,
    status: 'idle',
    counts: { total: 0, pending: 0, outcomeUnknown: 0, needsAttention: 0, orphanRisk: 0 },
    items: [],
    truncated: false,
    ...overrides,
  };
}

function renderSection() {
  return render(
    <MemoryRouter initialEntries={['/settings?section=integrations']}>
      <IntegrationsSection />
    </MemoryRouter>,
  );
}

describe('IntegrationsSection directory', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    activateProjectMock.mockReset();
    useAvailabilityMock.mockReset();
    useAvailabilityMock.mockReturnValue({ canUseIntegrations: true, reason: null });
    useDirectoryMock.mockReset();
    useDirectoryMock.mockReturnValue({
      directory: directoryWith(),
      isLoading: false,
      error: null,
    });
    useLegacyActionsMock.mockReset();
    useLegacyActionsMock.mockReturnValue(legacyActionsValue());
    useLegacyHealthMock.mockReset();
    useLegacyHealthMock.mockReturnValue({
      health: undefined,
      isLoading: false,
      error: null,
      verify: jest.fn(),
      retry: jest.fn(),
      pendingAction: undefined,
    });
  });

  afterEach(() => cleanup());

  it('shows an unavailable alert when runtime admission is denied', () => {
    useAvailabilityMock.mockReturnValue({ canUseIntegrations: false, reason: 'non_loopback_host' });

    renderSection();

    expect(screen.getByRole('alert')).toHaveTextContent(/only from the main local runtime/i);
  });

  it('exposes an accessible loading state', () => {
    useDirectoryMock.mockReturnValue({ directory: undefined, isLoading: true, error: null });

    renderSection();

    expect(screen.getByRole('status')).toHaveTextContent(/loading integrations/i);
  });

  it('exposes an accessible failure state', () => {
    useDirectoryMock.mockReturnValue({
      directory: undefined,
      isLoading: false,
      error: new Error('Directory failed.'),
    });

    renderSection();

    expect(screen.getByRole('alert')).toHaveTextContent('Directory failed.');
  });

  it('shows an accessible empty state when no projects exist', () => {
    useDirectoryMock.mockReturnValue({
      directory: { items: [], unassignedConnections: [], truncated: false },
      isLoading: false,
      error: null,
    });

    renderSection();

    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open board/i })).not.toBeInTheDocument();
  });

  it('groups rows by project and shows only safe configured fields', () => {
    renderSection();

    expect(screen.getByRole('heading', { name: 'Product' })).toBeInTheDocument();
    expect(screen.getByText('ClickUp')).toBeInTheDocument();
    expect(screen.getByText(/configured /i)).toBeInTheDocument();
    expect(screen.getByText(/managed sync on/i)).toBeInTheDocument();
    expect(screen.getByText('Jira')).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();

    // No ordinary mutation surface on normal rows.
    expect(screen.queryByLabelText(/personal api token/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/classic api token/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: /sync devchain sub-epics as managed subtasks/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^disconnect/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /replace .* credentials/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /health/i })).not.toBeInTheDocument();
  });

  it('disambiguates duplicate project names with their workspace', () => {
    useDirectoryMock.mockReturnValue({
      directory: directoryWith({
        items: [
          ...directoryWith().items,
          {
            project: { id: '22222222-2222-4222-8222-222222222222', name: 'Product' },
            workspace: { id: '55555555-5555-4555-8555-555555555555', name: 'Remote' },
            provider: 'clickup',
            configured: false,
            updatedAt: null,
            subtaskSyncEnabled: false,
            hasMigratedSharedOrigin: false,
          },
        ],
      }),
      isLoading: false,
      error: null,
    });

    renderSection();

    expect(screen.getByRole('heading', { name: 'Product · Main' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Product · Remote' })).toBeInTheDocument();
  });

  it('shows the migrated shared-origin warning on migrated rows', () => {
    useDirectoryMock.mockReturnValue({
      directory: directoryWith({
        items: [
          {
            project: { id: '11111111-1111-4111-8111-111111111111', name: 'Product' },
            workspace: { id: '44444444-4444-4444-8444-444444444444', name: 'Main' },
            provider: 'jira',
            configured: true,
            updatedAt: '2026-08-20T10:30:00.000Z',
            subtaskSyncEnabled: false,
            hasMigratedSharedOrigin: true,
          },
        ],
      }),
      isLoading: false,
      error: null,
    });

    renderSection();

    expect(screen.getByText('Migrated from a shared connection')).toBeInTheDocument();
  });

  it('notes when the directory is truncated', () => {
    useDirectoryMock.mockReturnValue({
      directory: directoryWith({ truncated: true }),
      isLoading: false,
      error: null,
    });

    renderSection();

    expect(screen.getByText(/only the first 100 projects/i)).toBeInTheDocument();
  });

  it('activates the owning project and workspace, then opens the provider Board', () => {
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Open ClickUp board for Product' }));

    expect(activateProjectMock).toHaveBeenCalledWith({
      id: '11111111-1111-4111-8111-111111111111',
      workspaceId: '44444444-4444-4444-8444-444444444444',
    });
    expect(navigateMock).toHaveBeenCalledWith('/board/clickup');
  });

  it('offers no Open Board action for an unconfigured provider row', () => {
    renderSection();

    expect(
      screen.queryByRole('button', { name: 'Open Jira board for Product' }),
    ).not.toBeInTheDocument();
  });
});

describe('IntegrationsSection legacy connections', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    activateProjectMock.mockReset();
    assignMock.mockReset();
    disconnectMock.mockReset();
    useAvailabilityMock.mockReset();
    useAvailabilityMock.mockReturnValue({ canUseIntegrations: true, reason: null });
    useDirectoryMock.mockReset();
    useDirectoryMock.mockReturnValue({
      directory: directoryWith({
        items: [
          {
            project: { id: '11111111-1111-4111-8111-111111111111', name: 'Product' },
            workspace: { id: '44444444-4444-4444-8444-444444444444', name: 'Main' },
            provider: 'clickup',
            configured: true,
            updatedAt: '2026-08-20T10:30:00.000Z',
            subtaskSyncEnabled: false,
            hasMigratedSharedOrigin: false,
          },
        ],
        unassignedConnections: [
          {
            provider: 'jira',
            connected: true,
            connectionId: '33333333-3333-4333-8333-333333333333',
            generation: 2,
            subtaskSyncEnabled: false,
            syncSettingRevision: null,
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
        ],
      }),
      isLoading: false,
      error: null,
    });
    useLegacyActionsMock.mockReset();
    useLegacyActionsMock.mockImplementation(() => legacyActionsValue());
    useLegacyHealthMock.mockReset();
    useLegacyHealthMock.mockReturnValue({
      health: undefined,
      isLoading: true,
      error: null,
      verify: jest.fn(),
      retry: jest.fn(),
      pendingAction: undefined,
    });
  });

  afterEach(() => cleanup());

  it('hides the legacy section when nothing is unassigned', () => {
    useDirectoryMock.mockReturnValue({
      directory: directoryWith(),
      isLoading: false,
      error: null,
    });

    renderSection();

    expect(screen.queryByRole('heading', { name: /legacy connections/i })).not.toBeInTheDocument();
  });

  it('offers only assign, health, and disconnect on a legacy row', () => {
    renderSection();

    const row = screen.getByRole('list', { name: /legacy unassigned connections/i });
    expect(within(row).getByText('Jira')).toBeInTheDocument();
    expect(within(row).getByText('Unassigned')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /assign to project/i })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /^health$/i })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
    expect(within(row).queryByLabelText(/token/i)).not.toBeInTheDocument();
  });

  it('assigns to a vacant project slot and surfaces conflicts in the dialog', async () => {
    const user = userEvent.setup();
    assignMock
      .mockRejectedValueOnce(new Error('Project already has a Jira connection.'))
      .mockResolvedValueOnce(undefined);
    useDirectoryMock.mockReturnValue({
      directory: directoryWith({
        items: [
          {
            project: { id: '11111111-1111-4111-8111-111111111111', name: 'Product' },
            workspace: { id: '44444444-4444-4444-8444-444444444444', name: 'Main' },
            provider: 'clickup',
            configured: true,
            updatedAt: '2026-08-20T10:30:00.000Z',
            subtaskSyncEnabled: false,
            hasMigratedSharedOrigin: false,
          },
          {
            project: { id: '22222222-2222-4222-8222-222222222222', name: 'Website' },
            workspace: { id: '44444444-4444-4444-8444-444444444444', name: 'Main' },
            provider: 'jira',
            configured: false,
            updatedAt: null,
            subtaskSyncEnabled: false,
            hasMigratedSharedOrigin: false,
          },
        ],
        unassignedConnections: [
          {
            provider: 'jira',
            connected: true,
            connectionId: '33333333-3333-4333-8333-333333333333',
            generation: 2,
            subtaskSyncEnabled: false,
            syncSettingRevision: null,
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
        ],
      }),
      isLoading: false,
      error: null,
    });

    renderSection();
    await user.click(screen.getByRole('button', { name: /assign to project/i }));

    const dialog = screen.getByRole('dialog', { name: /assign legacy jira connection/i });
    await user.click(within(dialog).getByRole('combobox', { name: /target project/i }));
    await user.click(screen.getByRole('option', { name: /website — main/i }));
    await user.click(within(dialog).getByRole('button', { name: /assign connection/i }));

    expect(assignMock).toHaveBeenCalledWith(
      '33333333-3333-4333-8333-333333333333',
      '22222222-2222-4222-8222-222222222222',
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /already has a jira connection/i,
    );
    expect(within(dialog).getByRole('button', { name: /assign connection/i })).toBeInTheDocument();
  });

  it('explains when no project has a vacant provider slot', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: /assign to project/i }));

    const dialog = screen.getByRole('dialog', { name: /assign legacy jira connection/i });
    expect(within(dialog).getByText(/no project has a vacant jira slot/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /assign connection/i })).toBeDisabled();
  });

  it('loads exact legacy health into the disclosure region', async () => {
    const user = userEvent.setup();
    useLegacyHealthMock.mockReturnValue({
      health: legacyHealthValue({
        provider: 'jira',
        status: 'needs_attention',
        counts: { total: 1, pending: 0, outcomeUnknown: 1, needsAttention: 0, orphanRisk: 0 },
        items: [],
      }),
      isLoading: false,
      error: null,
      verify: jest.fn(),
      retry: jest.fn(),
      pendingAction: undefined,
    });

    renderSection();
    await user.click(screen.getByRole('button', { name: /^health$/i }));

    expect(useLegacyHealthMock).toHaveBeenCalledWith('33333333-3333-4333-8333-333333333333');
    const region = screen.getByRole('region', { name: /legacy jira sync health/i });
    expect(within(region).getByText(/1 unconfirmed/i)).toBeInTheDocument();
    expect(within(region).getByText(/no managed subtasks need recovery/i)).toBeInTheDocument();
  });

  it('surfaces a rejected legacy recovery action accessibly and clears it on later success', async () => {
    const user = userEvent.setup();
    const verify = jest
      .fn()
      .mockRejectedValueOnce(new Error('Provider unreachable.'))
      .mockResolvedValue(undefined);
    const retry = jest.fn().mockResolvedValue(undefined);
    useLegacyHealthMock.mockReturnValue({
      health: legacyHealthValue({
        provider: 'jira',
        status: 'needs_attention',
        counts: { total: 1, pending: 0, outcomeUnknown: 1, needsAttention: 0, orphanRisk: 0 },
        items: [
          {
            id: '77777777-7777-4777-8777-777777777777',
            epicId: 'epic-9',
            phase: 'outcome_unknown',
            tombstoneState: 'active',
            safeErrorCode: null,
            retryAt: null,
            remoteTaskId: 'ENG-9',
            openInSourceUrl: null,
            canVerify: true,
            canRetry: true,
          },
        ],
      }),
      isLoading: false,
      error: null,
      verify,
      retry,
      pendingAction: undefined,
    });

    renderSection();
    await user.click(screen.getByRole('button', { name: /^health$/i }));

    const region = screen.getByRole('region', { name: /legacy jira sync health/i });
    await user.click(
      within(region).getByRole('button', { name: /verify jira managed subtask for epic epic-9/i }),
    );

    const error = await within(region).findByRole('alert');
    expect(error).toHaveTextContent('Provider unreachable.');
    // The failure keeps the disclosure open so the row stays actionable.
    expect(screen.getByRole('region', { name: /legacy jira sync health/i })).toBeInTheDocument();

    await user.click(
      within(region).getByRole('button', { name: /retry jira managed subtask for epic epic-9/i }),
    );

    await waitFor(() => {
      expect(within(region).queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(within(region).getByRole('status')).toHaveTextContent(/retry completed/i);
  });

  it('escalates legacy disconnect to the orphan acknowledgement after a server rejection', async () => {
    const user = userEvent.setup();
    disconnectMock.mockRejectedValueOnce(
      new IntegrationConnectionApiError('Acknowledgement required.', {
        providerReason: 'orphan_risk_ack_required',
      }),
    );

    renderSection();
    await user.click(screen.getByRole('button', { name: /disconnect/i }));

    let dialog = screen.getByRole('dialog', { name: /disconnect legacy jira connection/i });
    expect(dialog.textContent).not.toMatch(/unproven remote outcomes/i);
    await user.click(within(dialog).getByRole('button', { name: /^disconnect$/i }));

    await waitFor(() => {
      dialog = screen.getByRole('dialog', { name: /disconnect legacy jira connection/i });
    });
    expect(dialog.textContent).toMatch(/unproven remote outcomes/i);
    expect(disconnectMock).toHaveBeenCalledWith('33333333-3333-4333-8333-333333333333', false);
  });
});
