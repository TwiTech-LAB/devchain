import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CloudPage } from './CloudPage';

// Mock hooks
const mockSetActiveSection = jest.fn();
const mockUseSubNavSearchParam = jest.fn();
jest.mock('@/ui/hooks/useSubNavSearchParam', () => ({
  useSubNavSearchParam: (...args: unknown[]) => mockUseSubNavSearchParam(...args),
}));

jest.mock('@/ui/hooks/useCloudConnection', () => ({
  useCloudConnection: () => ({
    status: { connected: false, identityServiceUrl: 'http://localhost:3002' },
    isLoading: false,
    disconnect: jest.fn(),
  }),
}));

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    projects: [],
    projectsLoading: false,
  }),
}));

// Mock section components
jest.mock('./cloud/AccountSection', () => ({
  AccountSection: () => <div data-testid="account-section">Account</div>,
}));

// NotificationsSection is NOT mocked for disconnected-path tests — we want real rendering.
// Import it explicitly for the disconnection tests below.

jest.mock('@/ui/components/shared', () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

function renderCloudPage(initialPath = '/cloud') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/cloud" element={<CloudPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CloudPage', () => {
  beforeEach(() => {
    mockUseSubNavSearchParam.mockReset();
    mockSetActiveSection.mockReset();
  });

  it('renders the Cloud page with header and sidebar brand', () => {
    mockUseSubNavSearchParam.mockReturnValue(['account', jest.fn()]);
    renderCloudPage();
    expect(screen.getByText('Cloud Settings')).toBeInTheDocument();
    expect(screen.getByLabelText('Cloud navigation')).toBeInTheDocument();
    expect(screen.getByText('Cloud')).toBeInTheDocument();
  });

  it('renders with default account section active', () => {
    mockUseSubNavSearchParam.mockReturnValue(['account', jest.fn()]);
    renderCloudPage();
    expect(screen.getByRole('tab', { name: 'Account' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Notifications' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(screen.getByTestId('account-section')).toBeInTheDocument();
  });

  it('renders notifications section when active', () => {
    mockUseSubNavSearchParam.mockReturnValue(['notifications', jest.fn()]);
    renderCloudPage();
    expect(screen.getByRole('tab', { name: 'Notifications' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Account' })).toHaveAttribute('aria-selected', 'false');
    // useCloudConnection mock returns connected:false so the disconnected hint renders
    expect(
      screen.getByText(/Sign in to DevChain Cloud to manage notifications/i),
    ).toBeInTheDocument();
  });

  it('does not render account section when notifications is active', () => {
    mockUseSubNavSearchParam.mockReturnValue(['notifications', jest.fn()]);
    renderCloudPage();
    expect(screen.queryByTestId('account-section')).not.toBeInTheDocument();
  });

  it('sidebar tabs are keyboard reachable and activate on Enter', async () => {
    const setActiveSection = jest.fn();
    mockUseSubNavSearchParam.mockReturnValue(['account', setActiveSection]);
    renderCloudPage();

    const notificationsTab = screen.getByRole('tab', { name: 'Notifications' });
    notificationsTab.focus();
    expect(notificationsTab).toHaveFocus();
    expect(notificationsTab).toHaveClass('focus-visible:ring-2');

    const user = userEvent.setup();
    await user.keyboard('{Enter}');

    expect(setActiveSection).toHaveBeenCalledWith('notifications');
  });
});

describe('CloudPage — notifications disconnected path', () => {
  beforeEach(() => {
    mockUseSubNavSearchParam.mockReset();
    mockSetActiveSection.mockReset();
    mockUseSubNavSearchParam.mockReturnValue(['notifications', mockSetActiveSection]);
  });

  it('renders DisconnectedHint when signed out on notifications section', () => {
    renderCloudPage();
    expect(
      screen.getByText('Sign in to DevChain Cloud to manage notifications.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Go to Account/i })).toBeInTheDocument();
  });

  it('does not render cloud-auth-form in disconnected path', () => {
    renderCloudPage();
    expect(screen.queryByTestId('cloud-auth-form')).not.toBeInTheDocument();
  });

  it('invokes setActiveSection with "account" when Go to Account button is clicked', async () => {
    renderCloudPage();
    await userEvent.click(screen.getByRole('button', { name: /Go to Account/i }));
    expect(mockSetActiveSection).toHaveBeenCalledTimes(1);
    expect(mockSetActiveSection).toHaveBeenCalledWith('account');
  });
});
