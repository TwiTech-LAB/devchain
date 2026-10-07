import { render, screen } from '@testing-library/react';
import { ProjectForwardingRow } from './ProjectForwardingRow';

// Mock useDevicesQuery
const mockUseDevicesQuery = jest.fn();
jest.mock('@/ui/hooks/useDevicesQuery', () => ({
  useDevicesQuery: () => mockUseDevicesQuery(),
}));

// Mock React Query hooks
const mockUseQuery = jest.fn();
const mockUseMutation = jest.fn();
const mockSetQueryData = jest.fn();
jest.mock('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
  useQueryClient: () => ({ getQueryData: jest.fn(), setQueryData: mockSetQueryData }),
}));

// Mock tooltip components for testability
jest.mock('../ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-provider">{children}</div>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

const READY_NO_DEVICES = {
  status: 'ready' as const,
  devices: [],
  devicesAvailable: true,
  refetch: jest.fn(),
};
const READY_WITH_DEVICES = {
  status: 'ready' as const,
  devices: [{ id: 'd1', platform: 'iOS', createdAt: '2025-01-01' }],
  devicesAvailable: true,
  refetch: jest.fn(),
};
const ENDPOINT_MISSING = {
  status: 'endpoint-missing' as const,
  devices: [],
  devicesAvailable: false,
  refetch: jest.fn(),
};

describe('ProjectForwardingRow', () => {
  beforeEach(() => {
    mockUseDevicesQuery.mockReset();
    mockUseQuery.mockReset();
    mockUseMutation.mockReset();
    mockSetQueryData.mockReset();

    mockUseDevicesQuery.mockReturnValue(READY_NO_DEVICES);
    mockUseQuery.mockReturnValue({ data: { enabled: false }, isLoading: false });
    mockUseMutation.mockReturnValue({ mutate: jest.fn(), isPending: false });
  });

  it.each([
    { label: 'bulk pending', bulk: true, loading: false, pending: false },
    { label: 'config loading', bulk: false, loading: true, pending: false },
    { label: 'row update pending', bulk: false, loading: false, pending: true },
  ] as const)('disables switch for $label', ({ bulk, loading, pending }) => {
    mockUseQuery.mockReturnValue({
      data: loading ? undefined : { enabled: false },
      isLoading: loading,
    });
    mockUseMutation.mockReturnValue({ mutate: jest.fn(), isPending: pending });
    render(
      <ProjectForwardingRow
        projectId="p1"
        projectName="My Project"
        rootPath="/tmp/my-project"
        bulkPending={bulk}
      />,
    );
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('shows project identity and enabled switch with the no-device hint', () => {
    mockUseDevicesQuery.mockReturnValue(READY_NO_DEVICES);
    render(
      <ProjectForwardingRow
        projectId="p1"
        projectName="My Project"
        rootPath="/tmp/my-project"
        bulkPending={false}
      />,
    );
    {
      expect(screen.getByTestId('tooltip-content')).toHaveTextContent(
        'No device will receive these notifications yet.',
      );
    }
    {
      expect(screen.getByText('My Project')).toBeInTheDocument();
      const rootPath = screen.getByText('/tmp/my-project');
      expect(rootPath).toBeInTheDocument();
      expect(rootPath).toHaveClass('truncate');
      expect(rootPath).toHaveAttribute('title', '/tmp/my-project');
      expect(screen.getByLabelText(/push notifications for my project/i)).toBeInTheDocument();
      const icon = document.querySelector('svg.lucide-folder');
      expect(icon).not.toBeNull();
    }
    {
      expect(screen.getByRole('switch')).not.toBeDisabled();
    }
  });

  it('hides tooltip when devices are populated', () => {
    mockUseDevicesQuery.mockReturnValue(READY_WITH_DEVICES);
    render(
      <ProjectForwardingRow
        projectId="p1"
        projectName="My Project"
        rootPath="/tmp/my-project"
        bulkPending={false}
      />,
    );
    expect(screen.queryByTestId('tooltip-content')).not.toBeInTheDocument();
  });

  it('hides tooltip when status=endpoint-missing', () => {
    mockUseDevicesQuery.mockReturnValue(ENDPOINT_MISSING);
    render(
      <ProjectForwardingRow
        projectId="p1"
        projectName="My Project"
        rootPath="/tmp/my-project"
        bulkPending={false}
      />,
    );
    expect(screen.queryByTestId('tooltip-content')).not.toBeInTheDocument();
  });
});
