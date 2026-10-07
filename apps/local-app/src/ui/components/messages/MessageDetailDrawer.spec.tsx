import { fireEvent, render, screen } from '@testing-library/react';
import { MessageDetailDrawer } from './MessageDetailDrawer';
import type { MessageLogPreview } from './MessageActivityList';

// Mock the Radix Dialog portal to render inline for testing
jest.mock('@radix-ui/react-dialog', () => {
  const actual = jest.requireActual('@radix-ui/react-dialog');
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

const mockMessage: MessageLogPreview = {
  id: 'msg-123',
  timestamp: Date.now() - 5000,
  projectId: 'project-1',
  agentId: 'agent-456',
  agentName: 'Test Agent',
  preview: 'This is the full message content that should be displayed in the drawer.',
  source: 'epic.assigned',
  status: 'delivered',
  batchId: 'batch-789',
  deliveredAt: Date.now() - 3000,
  immediate: false,
};

const mockFailedMessage: MessageLogPreview = {
  id: 'msg-failed',
  timestamp: Date.now() - 2000,
  projectId: 'project-1',
  agentId: 'agent-456',
  agentName: 'Test Agent',
  preview: 'Failed message content',
  source: 'notification',
  status: 'failed',
  error: 'No active session found',
  immediate: true,
};

describe('MessageDetailDrawer', () => {
  const originalFetch = global.fetch;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = jest.fn(
      () =>
        new Promise<Response>(() => {
          // Keep fetch pending by default so tests that don't care about async content
          // don't trigger late state updates.
        }),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('renders nothing when message is null', () => {
    render(<MessageDetailDrawer message={null} onClose={jest.fn()} />);

    // Drawer should not be open
    expect(screen.queryByText('Message Details')).not.toBeInTheDocument();
  });

  it('renders drawer with message details when message is provided', async () => {
    // Q2: Override centralized fetch mock to simulate network error
    // The default mock in test-setup.ts returns ok:true, but this test needs rejection
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

    render(<MessageDetailDrawer message={mockMessage} onClose={jest.fn()} />);

    expect(screen.getByText('Message Details')).toBeInTheDocument();
    expect(screen.getByText('Test Agent')).toBeInTheDocument();
    expect(screen.getByText('epic.assigned')).toBeInTheDocument();

    // Content is shown in preview format or ContentBlock after fetch completes/fails
    // Use findByText for async content
    expect(
      await screen.findByText((content) => content.includes('This is the full message content')),
    ).toBeInTheDocument();
  });

  it.each([
    [
      'delivered',
      mockMessage,
      () => {
        expect(screen.getByText('delivered')).toBeInTheDocument();
        {
          expect(screen.getByText(/Delivered at/)).toBeInTheDocument();
        }
        {
          expect(screen.getByText('batch-789')).toBeInTheDocument();
        }
        {
          expect(screen.getByText('msg-123')).toBeInTheDocument();
          expect(screen.getByText('agent-456')).toBeInTheDocument();
        }
        {
          expect(screen.queryByText('Immediate')).not.toBeInTheDocument();
        }
        {
          expect(screen.queryByText('Sender Agent:')).not.toBeInTheDocument();
        }
        {
          expect(screen.getByRole('heading', { name: 'Message Details' })).toBeInTheDocument();
        }
      },
    ],
    [
      'failed',
      mockFailedMessage,
      () => {
        expect(screen.getByText('failed')).toBeInTheDocument();
        expect(screen.getByText('No active session found')).toBeInTheDocument();
        {
          expect(screen.getByText('Immediate')).toBeInTheDocument();
        }
      },
    ],
    [
      'queued',
      { ...mockMessage, status: 'queued' as const, deliveredAt: undefined },
      () => {
        expect(screen.getByText('queued')).toBeInTheDocument();
        expect(screen.queryByText(/Delivered at/)).not.toBeInTheDocument();
      },
    ],
  ] as const)('renders %s message details', (_status, message, check) => {
    render(<MessageDetailDrawer message={message} onClose={jest.fn()} />);
    check();
  });

  it('shows sender agent ID when present', () => {
    const messageWithSender: MessageLogPreview = {
      ...mockMessage,
      senderAgentId: 'sender-agent-123',
    };

    render(<MessageDetailDrawer message={messageWithSender} onClose={jest.fn()} />);

    expect(screen.getByText('sender-agent-123')).toBeInTheDocument();
  });

  it('does not show batch ID when not present', () => {
    const messageWithoutBatch: MessageLogPreview = {
      ...mockMessage,
      batchId: undefined,
    };

    render(<MessageDetailDrawer message={messageWithoutBatch} onClose={jest.fn()} />);

    expect(screen.queryByText('Batch ID')).not.toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = jest.fn();
    render(<MessageDetailDrawer message={mockMessage} onClose={onClose} />);

    const closeButton = screen.getByRole('button', { name: /close/i });
    fireEvent.click(closeButton);

    expect(onClose).toHaveBeenCalled();
  });
});
