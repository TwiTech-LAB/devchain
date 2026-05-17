import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockUpsertMutate = jest.fn();

jest.mock('@/ui/hooks/useQuietHours', () => ({
  useQuietHours: jest.fn(() => ({
    quietHours: null,
    isLoading: false,
    upsert: { mutate: mockUpsertMutate, isPending: false },
  })),
}));

import { QuietHoursConfig } from './QuietHoursConfig';
import { useQuietHours } from '@/ui/hooks/useQuietHours';

const mockUseQuietHours = useQuietHours as jest.Mock;

function renderConfig() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <QuietHoursConfig />
    </QueryClientProvider>,
  );
}

describe('QuietHoursConfig', () => {
  beforeEach(() => {
    mockUpsertMutate.mockReset();
    mockUseQuietHours.mockReturnValue({
      quietHours: null,
      isLoading: false,
      upsert: { mutate: mockUpsertMutate, isPending: false },
    });
  });

  it('renders quiet hours toggle', () => {
    renderConfig();
    expect(screen.getByRole('switch', { name: /enable quiet hours/i })).toBeInTheDocument();
  });

  it('renders card title and description', () => {
    renderConfig();
    expect(screen.getByRole('heading', { name: /quiet hours/i })).toBeInTheDocument();
    expect(
      screen.getByText(/mute non-critical notifications during this schedule/i),
    ).toBeInTheDocument();
  });

  it('shows helper note and Save changes button when enabled', () => {
    renderConfig();
    fireEvent.click(screen.getByRole('switch', { name: /enable quiet hours/i }));
    expect(
      screen.getByText(/account & security notifications are still delivered/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
  });

  it('hides time inputs when disabled', () => {
    renderConfig();
    expect(screen.queryByLabelText(/quiet hours start/i)).not.toBeInTheDocument();
  });

  it('shows time inputs when enabled', () => {
    renderConfig();
    fireEvent.click(screen.getByRole('switch', { name: /enable quiet hours/i }));
    expect(screen.getByLabelText(/quiet hours start/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/quiet hours end/i)).toBeInTheDocument();
  });

  it('auto-detects timezone from Intl.DateTimeFormat', () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    renderConfig();
    fireEvent.click(screen.getByRole('switch', { name: /enable quiet hours/i }));
    expect(screen.getByText(new RegExp(tz))).toBeInTheDocument();
  });

  it('shows error and disables Save when start === end', () => {
    renderConfig();
    fireEvent.click(screen.getByRole('switch', { name: /enable quiet hours/i }));

    const startInput = screen.getByLabelText(/quiet hours start/i);
    const endInput = screen.getByLabelText(/quiet hours end/i);
    fireEvent.change(startInput, { target: { value: '22:00' } });
    fireEvent.change(endInput, { target: { value: '22:00' } });

    expect(screen.getByRole('alert')).toHaveTextContent(/start and end times must differ/i);
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('cross-midnight save calls upsert with correct minutes', () => {
    renderConfig();
    fireEvent.click(screen.getByRole('switch', { name: /enable quiet hours/i }));
    mockUpsertMutate.mockClear();

    const startInput = screen.getByLabelText(/quiet hours start/i);
    const endInput = screen.getByLabelText(/quiet hours end/i);
    fireEvent.change(startInput, { target: { value: '22:00' } });
    fireEvent.change(endInput, { target: { value: '07:00' } });

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(mockUpsertMutate).toHaveBeenCalledWith(
      expect.objectContaining({ startMinutes: 1320, endMinutes: 420, enabled: true }),
    );
  });

  it('shows "Active now" badge when currently in quiet hours window', () => {
    mockUseQuietHours.mockReturnValue({
      quietHours: {
        enabled: true,
        startMinutes: 0,
        endMinutes: 1439,
        timezone: 'UTC',
      },
      isLoading: false,
      upsert: { mutate: mockUpsertMutate, isPending: false },
    });
    renderConfig();
    expect(screen.getByTestId('active-now-badge')).toBeInTheDocument();
  });

  it('timezone Change link opens popover with search input', async () => {
    renderConfig();
    fireEvent.click(screen.getByRole('switch', { name: /enable quiet hours/i }));
    const changeButton = screen.getByRole('button', { name: /^change$/i });
    expect(changeButton).toHaveClass('focus-visible:ring-2');
    fireEvent.click(changeButton);

    await waitFor(() => {
      expect(screen.getByTestId('tz-search')).toBeInTheDocument();
    });
  });

  it('toggling off fires PUT with enabled:false and preserves time values', () => {
    mockUseQuietHours.mockReturnValue({
      quietHours: {
        enabled: true,
        startMinutes: 480,
        endMinutes: 1320,
        timezone: 'America/New_York',
      },
      isLoading: false,
      upsert: { mutate: mockUpsertMutate, isPending: false },
    });
    renderConfig();

    const toggle = screen.getByRole('switch', { name: /enable quiet hours/i });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);

    expect(mockUpsertMutate).toHaveBeenCalledWith(
      {
        enabled: false,
        startMinutes: 480,
        endMinutes: 1320,
        timezone: 'America/New_York',
      },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
    expect(toggle).not.toBeChecked();
  });

  it('toggling off preserves distinct start/end times (NP7)', () => {
    mockUseQuietHours.mockReturnValue({
      quietHours: {
        enabled: true,
        startMinutes: 480,
        endMinutes: 1320,
        timezone: 'America/New_York',
      },
      isLoading: false,
      upsert: { mutate: mockUpsertMutate, isPending: false },
    });
    renderConfig();

    fireEvent.click(screen.getByRole('switch', { name: /enable quiet hours/i }));

    const call = mockUpsertMutate.mock.calls[0][0];
    expect(call.startMinutes).not.toBe(call.endMinutes);
    expect(call.startMinutes).toBe(480);
    expect(call.endMinutes).toBe(1320);
  });

  it('rolls back toggle on mutation failure', async () => {
    mockUpsertMutate.mockImplementation((_args: unknown, opts?: { onError?: () => void }) => {
      opts?.onError?.();
    });

    mockUseQuietHours.mockReturnValue({
      quietHours: {
        enabled: true,
        startMinutes: 480,
        endMinutes: 1320,
        timezone: 'America/New_York',
      },
      isLoading: false,
      upsert: { mutate: mockUpsertMutate, isPending: false },
    });
    renderConfig();

    const toggle = screen.getByRole('switch', { name: /enable quiet hours/i });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toggle).toBeChecked();
    });
  });

  it('selecting a timezone from popover updates the displayed timezone', async () => {
    renderConfig();
    fireEvent.click(screen.getByRole('switch', { name: /enable quiet hours/i }));
    fireEvent.click(screen.getByRole('button', { name: /^change$/i }));

    await waitFor(() => screen.getByTestId('tz-search'));
    fireEvent.change(screen.getByTestId('tz-search'), {
      target: { value: 'America/New_York' },
    });

    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /^America\/New_York$/ });
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(screen.getByText(/America\/New_York/)).toBeInTheDocument();
    });
  });
});
