import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AccountSection } from './AccountSection';

const mockUseCloudConnection = jest.fn();
jest.mock('@/ui/hooks/useCloudConnection', () => ({
  useCloudConnection: () => mockUseCloudConnection(),
}));

jest.mock('@/ui/components/cloud/CloudAuthForm', () => ({
  CloudAuthForm: ({ identityServiceUrl }: { identityServiceUrl: string }) => (
    <div data-testid="cloud-auth-form">Connect {identityServiceUrl}</div>
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
    userId: 'user-abc12345',
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
      <AccountSection />
    </QueryClientProvider>,
  );
}

describe('AccountSection', () => {
  beforeEach(() => {
    mockUseCloudConnection.mockReset();
  });

  it('shows loading state while checking connection', () => {
    mockUseCloudConnection.mockReturnValue(LOADING);
    renderSection();
    expect(screen.getByText('Checking connection...')).toBeInTheDocument();
  });

  it('shows auth form when signed out', () => {
    mockUseCloudConnection.mockReturnValue(DISCONNECTED);
    renderSection();
    expect(screen.getByTestId('cloud-auth-form')).toBeInTheDocument();
  });

  it('shows account details when signed in', () => {
    mockUseCloudConnection.mockReturnValue(CONNECTED);
    renderSection();

    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('user@example.com')).toBeInTheDocument();
    expect(screen.getByText(/Switch account/)).toBeInTheDocument();
    expect(screen.getByText('Disconnect')).toBeInTheDocument();
  });
});
