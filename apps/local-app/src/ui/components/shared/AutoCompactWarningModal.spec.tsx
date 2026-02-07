import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AutoCompactWarningModal } from './AutoCompactWarningModal';

jest.mock('@radix-ui/react-dialog', () => {
  const actual = jest.requireActual('@radix-ui/react-dialog');
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function mockResponse(overrides: Partial<Response> = {}): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '',
    ...overrides,
  } as Response;
}

describe('AutoCompactWarningModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: jest.fn(),
    providerId: 'provider-1',
    providerName: 'Claude',
    onDisabled: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockResponse({ ok: true })) as unknown as typeof fetch;
  });

  it('renders warning title and explanation content', () => {
    render(<AutoCompactWarningModal {...defaultProps} />);

    expect(screen.getByText('Claude Auto-Compact Detected')).toBeInTheDocument();
    expect(
      screen.getByText(/Claude Code's built-in auto-compact feature is currently enabled/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Devchain handles context compaction automatically/i),
    ).toBeInTheDocument();
  });

  it('shows blocked session line when agentName is provided', () => {
    render(<AutoCompactWarningModal {...defaultProps} agentName="Builder Agent" />);
    expect(screen.getByText('Blocked session: Builder Agent')).toBeInTheDocument();
  });

  it('closes modal when Cancel is clicked', () => {
    render(<AutoCompactWarningModal {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('disables primary action and shows fallback guidance when providerId is empty', () => {
    render(<AutoCompactWarningModal {...defaultProps} providerId="" />);

    expect(
      screen.getByText(
        /Unable to identify the Claude provider\. Please disable auto-compact manually by setting/i,
      ),
    ).toBeInTheDocument();
    const disableButton = screen.getByRole('button', { name: 'Disable & Continue' });
    expect(disableButton).toBeDisabled();

    fireEvent.click(disableButton);
    expect(global.fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('calls disable endpoint and invokes callback on success', async () => {
    render(<AutoCompactWarningModal {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disable & Continue' }));
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/providers/provider-1/auto-compact/disable', {
        method: 'POST',
      });
      expect(defaultProps.onDisabled).toHaveBeenCalledTimes(1);
      expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('shows loading spinner state while API call is in progress', async () => {
    let resolveFetch: (value: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    global.fetch = jest.fn().mockReturnValue(pendingFetch) as unknown as typeof fetch;

    render(<AutoCompactWarningModal {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disable & Continue' }));
    });

    expect(screen.getByText('Disabling...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await act(async () => {
      resolveFetch!(mockResponse({ ok: true }));
    });
  });

  it('shows error alert when API request fails', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ message: 'Failed to write ~/.claude.json' }),
      }),
    ) as unknown as typeof fetch;

    render(<AutoCompactWarningModal {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disable & Continue' }));
    });

    await waitFor(() => {
      expect(screen.getByText('Disable Failed')).toBeInTheDocument();
      expect(screen.getByText('Failed to write ~/.claude.json')).toBeInTheDocument();
    });
    expect(defaultProps.onDisabled).not.toHaveBeenCalled();
    expect(defaultProps.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('does not close dialog while API call is in progress', async () => {
    let resolveFetch: (value: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    global.fetch = jest.fn().mockReturnValue(pendingFetch) as unknown as typeof fetch;

    render(<AutoCompactWarningModal {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disable & Continue' }));
    });

    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(defaultProps.onOpenChange).not.toHaveBeenCalledWith(false);

    await act(async () => {
      resolveFetch!(mockResponse({ ok: false, text: async () => 'still failing' }));
    });
  });
});
