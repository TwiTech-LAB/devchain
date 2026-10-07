import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock useCloudConnection — always connected so query is enabled
const mockUseCloudConnection = jest.fn();
jest.mock('@/ui/hooks/useCloudConnection', () => ({
  useCloudConnection: () => mockUseCloudConnection(),
}));

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

import { DevicesPanel } from './DevicesPanel';

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const TWO_DEVICES = {
  devices: [
    { id: 'd1', platform: 'iOS', appVersion: '1.0', lastActiveAt: null, createdAt: '2025-01-01' },
    { id: 'd2', platform: 'Android', createdAt: '2025-02-01' },
  ],
};

describe('DevicesPanel', () => {
  beforeEach(() => {
    global.fetch = mockFetch;
    mockFetch.mockReset();
    mockUseCloudConnection.mockReset().mockReturnValue({ status: { connected: true } });
  });

  it('renders loading state while devices are being fetched', () => {
    mockFetch.mockImplementation(() => new Promise(() => {})); // never resolves
    renderWithClient(<DevicesPanel />);
    expect(screen.getByText('Loading devices...')).toBeInTheDocument();
  });

  it.each([
    { label: 'returns null on 404 (endpoint-missing, Inv 11)', status: 404 },
    { label: 'returns null on 501 (endpoint-missing, Inv 11)', status: 501 },
  ] as const)('$label', async ({ status }) => {
    mockFetch.mockResolvedValue({ ok: false, status: status, json: async () => ({}) });
    const { container } = renderWithClient(<DevicesPanel />);
    await waitFor(() => {
      // Loading state should be gone and panel should render null
      expect(screen.queryByText('Loading devices...')).not.toBeInTheDocument();
    });
    expect(container.firstChild).toBeNull();
  });

  it('shows device state and its recovery or navigation action: renders error UI with retry button on 500', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    renderWithClient(<DevicesPanel />);
    {
      await waitFor(() =>
        expect(screen.getByText(/Couldn't load device list/)).toBeInTheDocument(),
      );
      expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
    }
    {
      await waitFor(() =>
        expect(screen.getByText(/Couldn't load device list/)).toBeInTheDocument(),
      );
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => TWO_DEVICES });
      await userEvent.click(screen.getByRole('button', { name: /Retry/ }));
      await waitFor(() => expect(screen.getByText('iOS')).toBeInTheDocument());
    }
  });

  it('shows device state and its recovery or navigation action: renders empty state on 200 with empty devices', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ devices: [] }) });
    renderWithClient(<DevicesPanel />);
    {
      await waitFor(() => expect(screen.getByText(/No mobile devices yet/)).toBeInTheDocument());
    }
    {
      await waitFor(() => expect(screen.getByText(/No mobile devices yet/)).toBeInTheDocument());
      const link = screen.getByRole('link', { name: /get the devchain mobile app/i });
      expect(link).toHaveAttribute('href', '/cloud?section=account');
    }
  });

  it('renders list on 200 with devices', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => TWO_DEVICES });
    renderWithClient(<DevicesPanel />);
    await waitFor(() => expect(screen.getByText('iOS')).toBeInTheDocument());
    expect(screen.getByText('Android')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getAllByText('Push active')).toHaveLength(2);
  });

  it('renders single-device strip variant', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        devices: [
          {
            id: 'd1',
            platform: 'iOS',
            appVersion: '1.2.0',
            lastActiveAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
            createdAt: '2025-01-01',
          },
        ],
      }),
    });
    renderWithClient(<DevicesPanel />);
    await waitFor(() => expect(screen.getByText('iOS')).toBeInTheDocument());
    expect(screen.getByText(/1\.2\.0/)).toBeInTheDocument();
    expect(screen.getByText('Push active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send test push/i })).toBeInTheDocument();
    expect(screen.queryByText('Devices')).not.toBeInTheDocument();
  });
});
