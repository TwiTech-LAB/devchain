import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { UpgradeDialog } from './UpgradeDialog';

// Mock Radix Dialog portal to render inline for testing
jest.mock('@radix-ui/react-dialog', () => {
  const actual = jest.requireActual('@radix-ui/react-dialog');
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

// Mock useToast
const mockToast = jest.fn();
jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

// ResizeObserver mock for Radix components
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('UpgradeDialog', () => {
  const originalFetch = global.fetch;
  const originalConsoleError = console.error;
  const defaultProps = {
    projectId: 'proj-123',
    projectName: 'My Project',
    templateSlug: 'test-template',
    currentVersion: '1.0.0',
    targetVersion: '2.0.0',
    open: true,
    onClose: jest.fn(),
  };

  beforeAll(() => {
    // Suppress known react-query act() warnings from mutation callbacks
    // This is a known issue: https://github.com/TanStack/query/issues/1593
    console.error = (...args: unknown[]) => {
      const message = typeof args[0] === 'string' ? args[0] : '';
      if (message.includes('not wrapped in act')) {
        return; // Suppress this specific warning
      }
      originalConsoleError.apply(console, args);
    };
  });

  afterAll(() => {
    console.error = originalConsoleError;
  });

  afterEach(async () => {
    // Flush pending state updates
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (originalFetch) {
      global.fetch = originalFetch;
    }
    jest.clearAllMocks();
  });

  it('renders nothing when open is false', () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    renderWithProviders(<UpgradeDialog {...defaultProps} open={false} />);

    expect(screen.queryByText('Update Project')).not.toBeInTheDocument();
  });

  it('shows confirm step with version badges', () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    renderWithProviders(<UpgradeDialog {...defaultProps} />);

    expect(screen.getByText('Update Project')).toBeInTheDocument();
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    expect(screen.getByText('v2.0.0')).toBeInTheDocument();
  });

  it('displays what will change information', () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    renderWithProviders(<UpgradeDialog {...defaultProps} />);

    expect(screen.getByText('What will change')).toBeInTheDocument();
    expect(screen.getByText(/Prompts, profiles, agents, and statuses/)).toBeInTheDocument();
    expect(
      screen.getByText(/Your epics, records, and documents will NOT be affected/),
    ).toBeInTheDocument();
  });

  it('has Update and Cancel buttons in confirm step', () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    renderWithProviders(<UpgradeDialog {...defaultProps} />);

    expect(screen.getByRole('button', { name: /update/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('Cancel button calls onClose', () => {
    const onClose = jest.fn();
    global.fetch = jest.fn() as unknown as typeof fetch;

    renderWithProviders(<UpgradeDialog {...defaultProps} onClose={onClose} />);

    const cancelButton = screen.getByRole('button', { name: /cancel/i });
    fireEvent.click(cancelButton);

    expect(onClose).toHaveBeenCalled();
  });

  it('transitions to applying step when Update is clicked', async () => {
    let resolveUpgrade: (value: unknown) => void;
    const upgradePromise = new Promise((resolve) => {
      resolveUpgrade = resolve;
    });

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/registry/upgrade-project') && init?.method === 'POST') {
        await upgradePromise;
        return { ok: true, json: async () => ({ success: true, newVersion: '2.0.0' }) };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderWithProviders(<UpgradeDialog {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /update/i }));

    await waitFor(() => {
      expect(screen.getByText('Applying Update')).toBeInTheDocument();
      expect(screen.getByText(/Creating backup and applying changes/)).toBeInTheDocument();
    });

    // Cleanup
    resolveUpgrade!({});
  });

  it('transitions to done step on successful upgrade', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/registry/upgrade-project') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ success: true, newVersion: '2.0.0' }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderWithProviders(<UpgradeDialog {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /update/i }));

    // Wait for ALL state updates to complete
    await waitFor(() => {
      expect(screen.getByText('Update Complete')).toBeInTheDocument();
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Upgrade Complete' }),
      );
    });
  });

  it('shows toast and closes dialog when auto-restore succeeds', async () => {
    const onClose = jest.fn();
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/registry/upgrade-project') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            success: false,
            error: 'Import failed',
            restored: true,
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderWithProviders(<UpgradeDialog {...defaultProps} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: /update/i }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Upgrade Failed',
          description: 'Project was automatically restored to its previous state',
          variant: 'destructive',
        }),
      );
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('shows error step with manual restore when auto-restore fails', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/registry/upgrade-project') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            success: false,
            error: 'Import failed',
            restored: false,
            backupId: 'backup-123',
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderWithProviders(<UpgradeDialog {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /update/i }));

    await waitFor(() => {
      expect(screen.getByText('Update Failed')).toBeInTheDocument();
      expect(screen.getByText('Import failed')).toBeInTheDocument();
      expect(screen.getByText('Manual Restore Available')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /restore backup/i })).toBeInTheDocument();
    });
  });

  it('calls restore API when Restore Backup is clicked', async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/registry/upgrade-project') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            success: false,
            error: 'Import failed',
            restored: false,
            backupId: 'backup-123',
          }),
        };
      }
      if (url.includes('/api/registry/restore-backup') && init?.method === 'POST') {
        return { ok: true, json: async () => ({ success: true }) };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;
    global.fetch = fetchMock;

    const onClose = jest.fn();
    renderWithProviders(<UpgradeDialog {...defaultProps} onClose={onClose} />);

    // Click Update
    fireEvent.click(screen.getByRole('button', { name: /update/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /restore backup/i })).toBeInTheDocument();
    });

    // Click Restore
    fireEvent.click(screen.getByRole('button', { name: /restore backup/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/registry/restore-backup',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Backup Restored' }));
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('shows error step when upgrade API fails', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/registry/upgrade-project') && init?.method === 'POST') {
        return { ok: false, status: 500, json: async () => ({ message: 'Server error' }) };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderWithProviders(<UpgradeDialog {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /update/i }));

    await waitFor(() => {
      expect(screen.getByText('Update Failed')).toBeInTheDocument();
    });
  });

  it('Done button closes dialog', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/registry/upgrade-project') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ success: true, newVersion: '2.0.0' }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const onClose = jest.fn();
    renderWithProviders(<UpgradeDialog {...defaultProps} onClose={onClose} />);

    // Complete the upgrade flow
    fireEvent.click(screen.getByRole('button', { name: /update/i }));

    // Wait for all state updates before clicking Done
    await waitFor(() => {
      expect(screen.getByText('Update Complete')).toBeInTheDocument();
      expect(mockToast).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('displays project name in description', () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    renderWithProviders(<UpgradeDialog {...defaultProps} />);

    expect(screen.getByText(/My Project/)).toBeInTheDocument();
  });

  it('shows error without restore button when no backupId', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/registry/upgrade-project') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            success: false,
            error: 'Version not cached',
            // No backupId - validation failed before backup was created
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderWithProviders(<UpgradeDialog {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /update/i }));

    await waitFor(() => {
      expect(screen.getByText('Update Failed')).toBeInTheDocument();
      expect(screen.getByText('Version not cached')).toBeInTheDocument();
    });

    // Should NOT show restore button when no backupId
    expect(screen.queryByRole('button', { name: /restore backup/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Manual Restore Available')).not.toBeInTheDocument();
  });
});
