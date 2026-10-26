import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UpgradeDialog } from './UpgradeDialog';
import type { UpgradeProjectResponse } from '@/ui/pages/projects/lib/project-contracts';

jest.mock('@radix-ui/react-dialog', () => {
  const actual = jest.requireActual('@radix-ui/react-dialog');
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

const mockToast = jest.fn();
jest.mock('@/ui/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }));

(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function renderDialog(result: UpgradeProjectResponse, overrides: Record<string, unknown> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = {
    projectId: 'proj-123',
    projectName: 'My Project',
    targetVersion: '2.0.0',
    source: 'registry' as const,
    result,
    open: true,
    onClose: jest.fn(),
    ...overrides,
  };
  render(
    <QueryClientProvider client={queryClient}>
      <UpgradeDialog {...props} />
    </QueryClientProvider>,
  );
  return props;
}

describe('UpgradeDialog', () => {
  afterEach(() => jest.clearAllMocks());

  it('renders the structured success and prompt-transfer result', () => {
    const props = renderDialog({
      success: true,
      newVersion: '2.0.0',
      promptTransfer: { imported: 2, deleted: 1, preserved: 3, skipped: 4 },
    });

    expect(screen.getByText('Upgrade Complete')).toBeInTheDocument();
    expect(screen.getByText(/My Project has been upgraded to v2.0.0/)).toBeInTheDocument();
    expect(screen.getByText(/2 imported, 1 deleted, 3 preserved, 4 skipped/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(props.onClose).toHaveBeenCalled();
  });

  it('preserves Update terminology for bundled templates', () => {
    renderDialog({ success: true, newVersion: '2.0.0' }, { source: 'bundled' as const });

    expect(screen.getByText('Update Complete')).toBeInTheDocument();
    expect(screen.getByText(/has been updated/)).toBeInTheDocument();
  });

  it('explains a pre-mutation readiness failure and offers no restore', () => {
    renderDialog({
      success: false,
      mutationStarted: false,
      error: 'Import cannot start',
      readiness: {
        ready: false,
        issues: [
          {
            code: 'active_sessions',
            message: 'Stop active sessions before replacing this project.',
            details: { activeSessions: [{ id: 'session-1', agentId: 'agent-1' }] },
          },
        ],
      },
      backupId: 'server-only-backup',
    });

    expect(screen.getByText('Blocked before changes')).toBeInTheDocument();
    expect(screen.getByText(/No changes were made/)).toBeInTheDocument();
    expect(screen.getByText(/Stop active sessions/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /restore backup/i })).not.toBeInTheDocument();
  });

  it('explains when automatic restore succeeded', () => {
    renderDialog({ success: false, error: 'Import failed', restored: true });

    expect(screen.getByText('Upgrade Failed')).toBeInTheDocument();
    expect(screen.getByText('Previous state restored')).toBeInTheDocument();
    expect(screen.getByText(/automatically restored/)).toBeInTheDocument();
  });

  it('offers and executes manual restore when a backup remains', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ success: true }),
    })) as unknown as typeof fetch;
    const props = renderDialog({
      success: false,
      error: 'Import failed',
      restored: false,
      backupId: 'backup-123',
    });

    expect(screen.getByText('Manual Restore Available')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /restore backup/i }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/projects/proj-123/restore-backup',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ backupId: 'backup-123' }),
        }),
      ),
    );
    expect(await screen.findByText('Backup Restored')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(props.onClose).toHaveBeenCalled();
  });

  it('restores on the instance that ran the upgrade and reports the restore', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ success: true }),
    })) as unknown as typeof fetch;
    const onRestored = jest.fn();
    renderDialog(
      { success: false, error: 'Import failed', restored: false, backupId: 'backup-123' },
      { backend: 'remote-1', onRestored },
    );

    fireEvent.click(screen.getByRole('button', { name: /restore backup/i }));

    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(global.fetch).toHaveBeenCalledWith(
      '/r/remote-1/api/projects/proj-123/restore-backup',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps manual restore actionable when the restore request fails', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      json: async () => ({ message: 'Restore unavailable' }),
    })) as unknown as typeof fetch;
    renderDialog({ success: false, error: 'Import failed', backupId: 'backup-123' });

    fireEvent.click(screen.getByRole('button', { name: /restore backup/i }));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Restore Failed', description: 'Restore unavailable' }),
      ),
    );
    expect(screen.getByRole('button', { name: /restore backup/i })).toBeEnabled();
  });
});
