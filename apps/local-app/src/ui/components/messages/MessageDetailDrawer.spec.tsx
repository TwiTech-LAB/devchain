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

  it('shows status badge', () => {
    render(<MessageDetailDrawer message={mockMessage} onClose={jest.fn()} />);

    expect(screen.getByText('delivered')).toBeInTheDocument();
  });

  it('shows delivered time when available', () => {
    render(<MessageDetailDrawer message={mockMessage} onClose={jest.fn()} />);

    expect(screen.getByText(/Delivered at/)).toBeInTheDocument();
  });

  it('shows batch ID when present', () => {
    render(<MessageDetailDrawer message={mockMessage} onClose={jest.fn()} />);

    expect(screen.getByText('batch-789')).toBeInTheDocument();
  });

  it('shows error for failed messages', () => {
    render(<MessageDetailDrawer message={mockFailedMessage} onClose={jest.fn()} />);

    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.getByText('No active session found')).toBeInTheDocument();
  });

  it('shows metadata section with message ID and agent ID', () => {
    render(<MessageDetailDrawer message={mockMessage} onClose={jest.fn()} />);

    expect(screen.getByText('msg-123')).toBeInTheDocument();
    expect(screen.getByText('agent-456')).toBeInTheDocument();
  });

  it('does not show Immediate badge when immediate is false', () => {
    render(<MessageDetailDrawer message={mockMessage} onClose={jest.fn()} />);

    // Component only shows "Immediate" badge when true, nothing when false
    expect(screen.queryByText('Immediate')).not.toBeInTheDocument();
  });

  it('shows Immediate badge when immediate is true', () => {
    render(<MessageDetailDrawer message={mockFailedMessage} onClose={jest.fn()} />);

    // Component shows "Immediate" badge with Zap icon when immediate=true
    expect(screen.getByText('Immediate')).toBeInTheDocument();
  });

  it('shows sender agent ID when present', () => {
    const messageWithSender: MessageLogPreview = {
      ...mockMessage,
      senderAgentId: 'sender-agent-123',
    };

    render(<MessageDetailDrawer message={messageWithSender} onClose={jest.fn()} />);

    expect(screen.getByText('sender-agent-123')).toBeInTheDocument();
  });

  it('does not show sender agent ID when not present', () => {
    render(<MessageDetailDrawer message={mockMessage} onClose={jest.fn()} />);

    expect(screen.queryByText('Sender Agent:')).not.toBeInTheDocument();
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

  it('has accessible title', () => {
    render(<MessageDetailDrawer message={mockMessage} onClose={jest.fn()} />);

    expect(screen.getByRole('heading', { name: 'Message Details' })).toBeInTheDocument();
  });

  it('shows queued status correctly', () => {
    const queuedMessage: MessageLogPreview = {
      ...mockMessage,
      status: 'queued',
      deliveredAt: undefined,
    };

    render(<MessageDetailDrawer message={queuedMessage} onClose={jest.fn()} />);

    expect(screen.getByText('queued')).toBeInTheDocument();
    expect(screen.queryByText(/Delivered at/)).not.toBeInTheDocument();
  });
});
