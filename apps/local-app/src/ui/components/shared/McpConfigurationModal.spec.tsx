import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { McpConfigurationModal } from './McpConfigurationModal';

// Mock Radix Dialog portal to render inline for testing
jest.mock('@radix-ui/react-dialog', () => {
  const actual = jest.requireActual('@radix-ui/react-dialog');
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

// ResizeObserver mock for Radix components
(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock clipboard API
const mockClipboard = {
  writeText: jest.fn().mockResolvedValue(undefined),
};
Object.defineProperty(navigator, 'clipboard', {
  value: mockClipboard,
  writable: true,
});

describe('McpConfigurationModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: jest.fn(),
    providerId: 'provider-123',
    providerName: 'Claude',
    onConfigured: jest.fn(),
    onVerify: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders nothing when open is false', () => {
    render(<McpConfigurationModal {...defaultProps} open={false} />);
    expect(screen.queryByText('Manual MCP Configuration Required')).not.toBeInTheDocument();
  });

  it('displays the dialog title and provider name when open', () => {
    render(<McpConfigurationModal {...defaultProps} />);

    expect(screen.getByText('Manual MCP Configuration Required')).toBeInTheDocument();
    // Provider name appears in description
    expect(screen.getByText(/Auto-configuration failed for/)).toBeInTheDocument();
    expect(screen.getAllByText(/Claude/).length).toBeGreaterThanOrEqual(1);
  });

  it('displays correct manual command for Claude provider', () => {
    render(<McpConfigurationModal {...defaultProps} providerName="Claude" />);
    expect(screen.getByText(/claude mcp add --transport http devchain/)).toBeInTheDocument();
  });

  it('displays correct manual command for Codex provider', () => {
    render(<McpConfigurationModal {...defaultProps} providerName="Codex" />);
    expect(screen.getByText(/codex mcp add --url.*devchain/)).toBeInTheDocument();
  });

  it('displays correct manual command for Gemini provider', () => {
    render(<McpConfigurationModal {...defaultProps} providerName="Gemini" />);
    expect(screen.getByText(/gemini mcp add -t http devchain/)).toBeInTheDocument();
  });

  it('displays fallback command for unknown providers', () => {
    render(<McpConfigurationModal {...defaultProps} providerName="UnknownProvider" />);
    expect(screen.getByText(/# Manual MCP configuration for UnknownProvider/)).toBeInTheDocument();
  });

  it('calls onOpenChange when Cancel button is clicked', () => {
    render(<McpConfigurationModal {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows Run in Terminal section', () => {
    render(<McpConfigurationModal {...defaultProps} />);
    expect(screen.getByText('Run in Terminal')).toBeInTheDocument();
  });

  it('shows Verify Configuration button when onVerify is provided', () => {
    render(<McpConfigurationModal {...defaultProps} onVerify={jest.fn()} />);
    expect(screen.getByRole('button', { name: /Verify Configuration/i })).toBeInTheDocument();
  });

  it('does not show Verify Configuration button when onVerify is not provided', () => {
    render(<McpConfigurationModal {...defaultProps} onVerify={undefined} />);
    expect(screen.queryByRole('button', { name: /Verify Configuration/i })).not.toBeInTheDocument();
  });

  describe('Copy command flow', () => {
    it('copies command to clipboard when copy button is clicked', async () => {
      render(<McpConfigurationModal {...defaultProps} providerName="Claude" />);

      await act(async () => {
        fireEvent.click(screen.getByTitle('Copy to clipboard'));
      });

      expect(mockClipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('claude mcp add --transport http devchain'),
      );
    });
  });

  describe('Verify flow', () => {
    it('calls onVerify when Verify Configuration is clicked', async () => {
      const mockVerify = jest.fn().mockResolvedValue(true);
      render(<McpConfigurationModal {...defaultProps} onVerify={mockVerify} />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Verify Configuration/i }));
      });

      await waitFor(() => {
        expect(mockVerify).toHaveBeenCalled();
      });
    });

    it('calls onConfigured and closes modal when verification succeeds', async () => {
      const mockVerify = jest.fn().mockResolvedValue(true);
      render(<McpConfigurationModal {...defaultProps} onVerify={mockVerify} />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Verify Configuration/i }));
      });

      await waitFor(() => {
        expect(defaultProps.onConfigured).toHaveBeenCalled();
        expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
      });
    });

    it('shows error when verification fails', async () => {
      const mockVerify = jest.fn().mockResolvedValue(false);
      render(<McpConfigurationModal {...defaultProps} onVerify={mockVerify} />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Verify Configuration/i }));
      });

      await waitFor(() => {
        expect(screen.getByText('Configuration Error')).toBeInTheDocument();
        expect(screen.getByText(/MCP configuration not detected/)).toBeInTheDocument();
      });
    });

    it('shows loading state while verifying', async () => {
      let resolvePromise: (value: boolean) => void;
      const pendingPromise = new Promise<boolean>((resolve) => {
        resolvePromise = resolve;
      });
      const mockVerify = jest.fn().mockReturnValue(pendingPromise);
      render(<McpConfigurationModal {...defaultProps} onVerify={mockVerify} />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Verify Configuration/i }));
      });

      expect(screen.getByText('Verifying...')).toBeInTheDocument();

      // Cleanup
      await act(async () => {
        resolvePromise!(true);
      });
    });
  });

  describe('MCP info section', () => {
    it('displays MCP explanation text', () => {
      render(<McpConfigurationModal {...defaultProps} />);
      expect(
        screen.getByText(/MCP \(Model Context Protocol\) enables Claude to communicate/),
      ).toBeInTheDocument();
    });
  });
});
