import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationsSection } from './NotificationsSection';

// Mock useCloudConnection
const mockUseCloudConnection = jest.fn();
jest.mock('@/ui/hooks/useCloudConnection', () => ({
  useCloudConnection: (backend?: string) => mockUseCloudConnection(backend),
}));

// Mock useCloudTarget (the Cloud page target selector state)
const mockUseCloudTarget = jest.fn();
jest.mock('@/ui/hooks/useCloudTarget', () => ({
  useCloudTarget: () => mockUseCloudTarget(),
}));

// Mock DisconnectedHint
jest.mock('./DisconnectedHint', () => ({
  DisconnectedHint: ({ onNavigateToAccount }: { onNavigateToAccount: () => void }) => (
    <div data-testid="disconnected-hint">
      <button onClick={onNavigateToAccount}>Go to Account</button>
    </div>
  ),
}));

jest.mock('@/ui/components/cloud/DevicesPanel', () => ({
  DevicesPanel: ({ backend }: { backend?: string }) => (
    <div data-testid="devices-panel" data-backend={backend ?? 'home'} />
  ),
}));

jest.mock('@/ui/components/cloud/NotificationPreferencesPanel', () => ({
  NotificationPreferencesPanel: () => <div data-testid="notification-preferences-panel" />,
}));

jest.mock('@/ui/components/cloud/QuietHoursConfig', () => ({
  QuietHoursConfig: () => <div data-testid="quiet-hours-config" />,
}));

jest.mock('@/ui/components/cloud/ProjectForwardingList', () => ({
  ProjectForwardingList: () => <div data-testid="project-forwarding-list" />,
}));

const HOME_TARGET = {
  backend: 'home',
  remoteName: null,
  eligible: [],
  selectorVisible: false,
  selectTarget: jest.fn(),
};

const REMOTE_TARGET = { ...HOME_TARGET, backend: 'r1', remoteName: 'lab-vm' };

const DISCONNECTED = {
  status: { connected: false, identityServiceUrl: 'http://localhost:3002' },
  isLoading: false,
  disconnect: jest.fn(),
};

const CONNECTED = {
  status: {
    connected: true,
    identityServiceUrl: 'http://localhost:3002',
    email: 'user@example.com',
    userId: 'user-123',
  },
  isLoading: false,
  disconnect: jest.fn(),
};

const LOADING = {
  status: { connected: false, identityServiceUrl: '' },
  isLoading: true,
  disconnect: jest.fn(),
};

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <NotificationsSection onNavigateToAccount={jest.fn()} />
    </QueryClientProvider>,
  );
}

describe('NotificationsSection', () => {
  beforeEach(() => {
    mockUseCloudConnection.mockReset();
    mockUseCloudTarget.mockReset().mockReturnValue(HOME_TARGET);
  });

  it('shows loading state while checking connection', () => {
    mockUseCloudConnection.mockReturnValue(LOADING);
    renderSection();
    expect(screen.getByText('Checking connection...')).toBeInTheDocument();
  });

  it('renders DisconnectedHint when signed out', () => {
    mockUseCloudConnection.mockReturnValue(DISCONNECTED);
    renderSection();
    expect(screen.getByTestId('disconnected-hint')).toBeInTheDocument();
    expect(screen.queryByTestId('devices-panel')).not.toBeInTheDocument();
  });

  it('keeps all notification panels for a signed-in This PC target', () => {
    mockUseCloudConnection.mockReturnValue(CONNECTED);
    renderSection();
    expect(screen.getByTestId('devices-panel')).toHaveAttribute('data-backend', 'home');
    expect(screen.getByTestId('notification-preferences-panel')).toBeInTheDocument();
    expect(screen.getByTestId('quiet-hours-config')).toBeInTheDocument();
    expect(screen.getByTestId('project-forwarding-list')).toBeInTheDocument();
    expect(screen.queryByTestId('disconnected-hint')).not.toBeInTheDocument();
  });

  it('shows remote devices and the This PC hint when only the remote is signed in', () => {
    mockUseCloudTarget.mockReturnValue(REMOTE_TARGET);
    mockUseCloudConnection.mockImplementation((backend?: string) =>
      backend === 'home' ? DISCONNECTED : CONNECTED,
    );
    renderSection();

    expect(mockUseCloudConnection).toHaveBeenCalledWith('r1');
    expect(mockUseCloudConnection).toHaveBeenCalledWith('home');
    expect(screen.getByTestId('devices-panel')).toHaveAttribute('data-backend', 'r1');
    expect(
      screen.getByText(
        'Preferences, quiet hours and forwarding belong to This PC. Sign This PC in to DevChain Cloud to change them.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('notification-preferences-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quiet-hours-config')).not.toBeInTheDocument();
    expect(screen.queryByTestId('project-forwarding-list')).not.toBeInTheDocument();
  });

  it('shows the home panels with a remote target when This PC is also signed in', () => {
    mockUseCloudTarget.mockReturnValue(REMOTE_TARGET);
    mockUseCloudConnection.mockReturnValue(CONNECTED);
    renderSection();

    expect(mockUseCloudConnection).toHaveBeenCalledWith('r1');
    expect(screen.getByTestId('devices-panel')).toHaveAttribute('data-backend', 'r1');
    expect(screen.getByTestId('notification-preferences-panel')).toBeInTheDocument();
    expect(screen.getByTestId('quiet-hours-config')).toBeInTheDocument();
    expect(screen.getByTestId('project-forwarding-list')).toBeInTheDocument();
    expect(screen.queryByText(/belong to This PC/)).not.toBeInTheDocument();
  });

  it('does not issue PUT to egress endpoint when signed out', () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    } as Response);

    mockUseCloudConnection.mockReturnValue(DISCONNECTED);
    renderSection();

    const putCalls = fetchSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('/api/cloud/egress/projects/') &&
        (call[1] as RequestInit | undefined)?.method === 'PUT',
    );
    expect(putCalls).toHaveLength(0);

    fetchSpy.mockRestore();
  });
});
