import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TestPushButton } from './TestPushButton';

function renderButton(props?: React.ComponentProps<typeof TestPushButton>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TestPushButton {...props} />
    </QueryClientProvider>,
  );
}

describe('TestPushButton', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('renders the button', () => {
    renderButton();
    expect(screen.getByRole('button', { name: /send test push/i })).toBeInTheDocument();
  });

  it('shows success message with device count on success', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ sent: 2, failed: 0 }),
    } as Response);

    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /send test push/i }));

    await waitFor(() => {
      expect(screen.getByText(/test push sent to 2 devices/i)).toBeInTheDocument();
    });
  });

  it('shows singular device message when sent=1', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ sent: 1, failed: 0 }),
    } as Response);

    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /send test push/i }));

    await waitFor(() => {
      expect(screen.getByText(/test push sent to 1 device\./i)).toBeInTheDocument();
    });
  });

  it('sends a deviceId when rendered for one device', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ sent: 1, failed: 0 }),
    } as Response);

    renderButton({ deviceId: 'device-1', deviceLabel: 'Android' });
    fireEvent.click(screen.getByRole('button', { name: /send test push/i }));

    await waitFor(() => {
      expect(screen.getByText(/test push sent to android/i)).toBeInTheDocument();
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/cloud/preferences/test-push',
      expect.objectContaining({
        body: JSON.stringify({ deviceId: 'device-1' }),
      }),
    );
  });

  it('shows no-devices message when sent=0 and failed=0', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ sent: 0, failed: 0 }),
    } as Response);

    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /send test push/i }));

    await waitFor(() => {
      expect(screen.getByText(/no devices registered/i)).toBeInTheDocument();
    });
  });

  it('shows partial failure breakdown', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ sent: 1, failed: 2 }),
    } as Response);

    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /send test push/i }));

    await waitFor(() => {
      expect(screen.getByText(/sent: 1\. failed: 2/i)).toBeInTheDocument();
    });
  });

  it('keeps failure copy scoped to selected device', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ sent: 1, failed: 2 }),
    } as Response);

    renderButton({ deviceId: 'device-1', deviceLabel: 'Android' });
    fireEvent.click(screen.getByRole('button', { name: /send test push/i }));

    await waitFor(() => {
      expect(screen.getByText(/android: sent 1\. failed: 2\./i)).toBeInTheDocument();
    });
  });

  it('shows error message on fetch failure', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response);

    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /send test push/i }));

    await waitFor(() => {
      expect(screen.getByText(/test push failed/i)).toBeInTheDocument();
    });
  });

  it('keeps error copy scoped to selected device', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response);

    renderButton({ deviceId: 'device-1', deviceLabel: 'iOS' });
    fireEvent.click(screen.getByRole('button', { name: /send test push/i }));

    await waitFor(() => {
      expect(screen.getByText(/test push to ios failed/i)).toBeInTheDocument();
    });
  });
});
