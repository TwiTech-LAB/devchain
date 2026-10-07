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

jest.mock('./cloud/RemoteVmSection', () => ({
  RemoteVmSection: () => <div data-testid="remote-vm-section">Remote VM</div>,
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

  it.each([
    { section: 'account', tab: 'Account', testId: 'account-section' },
    { section: 'notifications', tab: 'Notifications', testId: null },
    { section: 'remote-vm', tab: 'Remote VMs', testId: 'remote-vm-section' },
  ])('renders the active $section section', ({ section, tab, testId }) => {
    mockUseSubNavSearchParam.mockReturnValue([section, jest.fn()]);
    renderCloudPage();
    expect(screen.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
    if (testId) expect(screen.getByTestId(testId)).toBeInTheDocument();
    if (section === 'account')
      expect(screen.getByRole('tab', { name: 'Notifications' })).toHaveAttribute(
        'aria-selected',
        'false',
      );
    else {
      expect(screen.getByRole('tab', { name: 'Account' })).toHaveAttribute(
        'aria-selected',
        'false',
      );
      expect(screen.queryByTestId('account-section')).not.toBeInTheDocument();
    }
    if (section === 'notifications')
      expect(
        screen.getByText(/Sign in to DevChain Cloud to manage notifications/i),
      ).toBeInTheDocument();
  });

  it('sidebar tabs are keyboard reachable and activate on Enter', async () => {
    const setActiveSection = jest.fn();
    mockUseSubNavSearchParam.mockReturnValue(['account', setActiveSection]);
    renderCloudPage();

    const notificationsTab = screen.getByRole('tab', { name: 'Notifications' });
    notificationsTab.focus();
    expect(notificationsTab).toHaveFocus();

    const user = userEvent.setup();
    await user.keyboard('{Enter}');

    expect(setActiveSection).toHaveBeenCalledWith('notifications');
  });

  it('switches to Remote VMs with the section=remote-vm key', async () => {
    const setActiveSection = jest.fn();
    mockUseSubNavSearchParam.mockReturnValue(['account', setActiveSection]);
    renderCloudPage();

    await userEvent.click(screen.getByRole('tab', { name: 'Remote VMs' }));
    expect(setActiveSection).toHaveBeenCalledWith('remote-vm');
  });
});

describe('CloudPage — notifications disconnected path', () => {
  beforeEach(() => {
    mockUseSubNavSearchParam.mockReset();
    mockSetActiveSection.mockReset();
    mockUseSubNavSearchParam.mockReturnValue(['notifications', mockSetActiveSection]);
  });

  it('invokes setActiveSection with "account" when Go to Account button is clicked', async () => {
    renderCloudPage();
    await userEvent.click(screen.getByRole('button', { name: /Go to Account/i }));
    expect(mockSetActiveSection).toHaveBeenCalledTimes(1);
    expect(mockSetActiveSection).toHaveBeenCalledWith('account');
  });
});
