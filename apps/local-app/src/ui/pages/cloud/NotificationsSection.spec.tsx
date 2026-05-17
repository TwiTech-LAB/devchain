import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationsSection } from './NotificationsSection';

// Mock useCloudConnection
const mockUseCloudConnection = jest.fn();
jest.mock('@/ui/hooks/useCloudConnection', () => ({
  useCloudConnection: () => mockUseCloudConnection(),
}));

// Mock useSelectedProject (provides projects list)
const mockUseSelectedProject = jest.fn();
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => mockUseSelectedProject(),
}));

// Mock DisconnectedHint
jest.mock('./DisconnectedHint', () => ({
  DisconnectedHint: ({ onNavigateToAccount }: { onNavigateToAccount: () => void }) => (
    <div data-testid="disconnected-hint">
      <button onClick={onNavigateToAccount}>Go to Account</button>
    </div>
  ),
}));

// Mock PushNotificationsPanel
jest.mock('./PushNotificationsPanel', () => ({
  PushNotificationsPanel: () => (
    <div data-testid="push-notifications-panel">Push Notifications</div>
  ),
}));

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
    mockUseSelectedProject.mockReset();
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
    expect(screen.queryByTestId('push-notifications-panel')).not.toBeInTheDocument();
  });

  it('renders PushNotificationsPanel when signed in', () => {
    mockUseCloudConnection.mockReturnValue(CONNECTED);
    renderSection();
    expect(screen.getByTestId('push-notifications-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('disconnected-hint')).not.toBeInTheDocument();
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
