import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { SyncButton } from './SyncButton';

const toastSpy = jest.fn();
const triggerSyncMock = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

jest.mock('@/ui/lib/skills', () => {
  const actual = jest.requireActual('@/ui/lib/skills');
  return {
    ...actual,
    triggerSync: (...args: unknown[]) => triggerSyncMock(...args),
  };
});

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('SyncButton', () => {
  beforeEach(() => {
    triggerSyncMock.mockReset();
    toastSpy.mockReset();
  });

  it('shows "Sync in progress" when backend reports already_running', async () => {
    triggerSyncMock.mockResolvedValue({
      status: 'already_running',
      added: 0,
      updated: 0,
      failed: 0,
      unchanged: 0,
      errors: [],
    });

    renderWithQueryClient(<SyncButton />);

    fireEvent.click(screen.getByRole('button', { name: /sync skills now/i }));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Sync in progress',
        }),
      );
    });
  });

  it('shows completion summary when sync finishes normally', async () => {
    triggerSyncMock.mockResolvedValue({
      status: 'completed',
      added: 2,
      updated: 1,
      failed: 0,
      unchanged: 3,
      errors: [],
    });

    renderWithQueryClient(<SyncButton />);

    fireEvent.click(screen.getByRole('button', { name: /sync skills now/i }));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Skills sync complete',
          description: 'Added: 2, Updated: 1, Failed: 0',
        }),
      );
    });
  });
});
