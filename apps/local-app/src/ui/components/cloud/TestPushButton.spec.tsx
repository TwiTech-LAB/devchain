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

  it.each([
    {
      label: 'multiple devices',
      sent: 2,
      failed: 0,
      props: {},
      text: /test push sent to 2 devices/i,
    },
    {
      label: 'singular device',
      sent: 1,
      failed: 0,
      props: {},
      text: /test push sent to 1 device\./i,
    },
    { label: 'no devices', sent: 0, failed: 0, props: {}, text: /no devices registered/i },
    { label: 'partial failure', sent: 1, failed: 2, props: {}, text: /sent: 1\. failed: 2/i },
    {
      label: 'selected device failure',
      sent: 1,
      failed: 2,
      props: { deviceId: 'device-1', deviceLabel: 'Android' },
      text: /android: sent 1\. failed: 2\./i,
    },
  ] as const)('$label', async ({ sent, failed, props, text }) => {
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ sent, failed }) } as Response);
    renderButton(props);
    fireEvent.click(screen.getByRole('button', { name: /send test push/i }));
    await waitFor(() => expect(screen.getByText(text)).toBeInTheDocument());
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

  it.each([
    { label: 'all devices', props: {}, text: /test push failed/i },
    {
      label: 'selected device',
      props: { deviceId: 'device-1', deviceLabel: 'iOS' },
      text: /test push to ios failed/i,
    },
  ] as const)('maps HTTP error for $label', async ({ props, text }) => {
    fetchSpy.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response);
    renderButton(props);
    fireEvent.click(screen.getByRole('button', { name: /send test push/i }));
    await waitFor(() => expect(screen.getByText(text)).toBeInTheDocument());
  });
});
