import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessagesPage } from './MessagesPage';
import type { MessageLogEntry, MessageFilters } from '@/ui/components/messages';

// Mock useSelectedProject hook
const mockUseSelectedProject = jest.fn();
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => mockUseSelectedProject(),
}));

// Mock child components
jest.mock('@/ui/components/messages', () => ({
  CurrentPoolsPanel: ({
    projectId,
    onAgentClick,
    selectedAgentId,
  }: {
    projectId: string;
    onAgentClick: (agentId: string) => void;
    selectedAgentId?: string;
  }) => (
    <div
      data-testid="current-pools-panel"
      data-project-id={projectId}
      data-selected={selectedAgentId}
    >
      <button onClick={() => onAgentClick('agent-1')}>Pool Card Agent 1</button>
      <button onClick={() => onAgentClick('agent-2')}>Pool Card Agent 2</button>
    </div>
  ),
  MessageActivityList: ({
    projectId,
    filters,
    onMessageClick,
  }: {
    projectId: string;
    filters?: MessageFilters;
    onMessageClick: (message: MessageLogEntry) => void;
  }) => (
    <div
      data-testid="message-activity-list"
      data-project-id={projectId}
      data-filters={JSON.stringify(filters || {})}
    >
      <button
        onClick={() =>
          onMessageClick({
            id: 'msg-1',
            timestamp: Date.now(),
            projectId: 'project-1',
            agentId: 'agent-1',
            agentName: 'Test Agent',
            text: 'Test message',
            source: 'test',
            status: 'delivered',
            immediate: false,
          })
        }
      >
        Message Row
      </button>
    </div>
  ),
  MessageDetailDrawer: ({
    message,
    onClose,
  }: {
    message: MessageLogEntry | null;
    onClose: () => void;
  }) => (
    <div data-testid="message-detail-drawer" data-open={!!message}>
      {message && (
        <>
          <div>Message: {message.id}</div>
          <button onClick={onClose}>Close Drawer</button>
        </>
      )}
    </div>
  ),
  MessageFiltersPanel: ({
    projectId,
    filters: _filters,
    onChange,
  }: {
    projectId: string;
    filters: MessageFilters;
    onChange: (filters: MessageFilters) => void;
  }) => (
    <div data-testid="message-filters-panel" data-project-id={projectId}>
      <button onClick={() => onChange({ status: 'delivered' })}>Set Status Filter</button>
      <button onClick={() => onChange({})}>Clear Filters</button>
    </div>
  ),
}));

// Mock shared components
jest.mock('@/ui/components/shared', () => ({
  PageHeader: ({ title, description }: { title: string; description: string }) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  ),
  EmptyState: ({ title, description }: { title: string; description: string }) => (
    <div data-testid="empty-state">
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  ),
}));

describe('MessagesPage', () => {
  beforeEach(() => {
    mockUseSelectedProject.mockReset();
  });

  describe('when no project is selected', () => {
    beforeEach(() => {
      mockUseSelectedProject.mockReturnValue({
        selectedProject: null,
      });
    });

    it('should show empty state', async () => {
      render(<MessagesPage />);

      expect(screen.getByTestId('empty-state')).toBeInTheDocument();
      expect(screen.getByText('No project selected')).toBeInTheDocument();
      expect(screen.getByText('Select a project to view message activity')).toBeInTheDocument();

      {
        expect(screen.queryByTestId('current-pools-panel')).not.toBeInTheDocument();
        expect(screen.queryByTestId('message-activity-list')).not.toBeInTheDocument();
      }
    });
  });

  describe('when a project is selected', () => {
    beforeEach(() => {
      mockUseSelectedProject.mockReturnValue({
        selectedProject: { id: 'project-1', name: 'Test Project' },
      });
    });

    it('should render page header', async () => {
      render(<MessagesPage />);

      expect(screen.getByTestId('page-header')).toBeInTheDocument();
      expect(screen.getByText('Messages')).toBeInTheDocument();

      {
        expect(screen.getByTestId('current-pools-panel')).toHaveAttribute(
          'data-project-id',
          'project-1',
        );
        expect(screen.getByTestId('message-filters-panel')).toHaveAttribute(
          'data-project-id',
          'project-1',
        );
        expect(screen.getByTestId('message-activity-list')).toHaveAttribute(
          'data-project-id',
          'project-1',
        );
      }
      {
        expect(screen.getByTestId('message-detail-drawer')).toBeInTheDocument();
        expect(screen.getByTestId('message-detail-drawer')).toHaveAttribute('data-open', 'false');
      }
    });
  });

  describe('pool card interaction', () => {
    beforeEach(() => {
      mockUseSelectedProject.mockReturnValue({
        selectedProject: { id: 'project-1', name: 'Test Project' },
      });
    });

    it('selects, switches and clears the pool agent filter', () => {
      render(<MessagesPage />);
      fireEvent.click(screen.getByText('Pool Card Agent 1'));
      expect(screen.getByTestId('current-pools-panel')).toHaveAttribute('data-selected', 'agent-1');
      expect(screen.getByTestId('message-activity-list')).toHaveAttribute(
        'data-filters',
        JSON.stringify({ agentId: 'agent-1' }),
      );
      fireEvent.click(screen.getByText('Pool Card Agent 2'));
      expect(screen.getByTestId('current-pools-panel')).toHaveAttribute('data-selected', 'agent-2');
      fireEvent.click(screen.getByText('Pool Card Agent 2'));
      expect(screen.getByTestId('current-pools-panel')).not.toHaveAttribute(
        'data-selected',
        'agent-2',
      );
    });
  });

  describe('filters interaction', () => {
    beforeEach(() => {
      mockUseSelectedProject.mockReturnValue({
        selectedProject: { id: 'project-1', name: 'Test Project' },
      });
    });

    it('should pass filters to activity list', async () => {
      render(<MessagesPage />);

      fireEvent.click(screen.getByText('Set Status Filter'));

      expect(screen.getByTestId('message-activity-list')).toHaveAttribute(
        'data-filters',
        JSON.stringify({ status: 'delivered' }),
      );

      {
        fireEvent.click(screen.getByText('Set Status Filter'));
        expect(screen.getByTestId('message-activity-list')).toHaveAttribute(
          'data-filters',
          JSON.stringify({ status: 'delivered' }),
        );
        fireEvent.click(screen.getByText('Clear Filters'));
        expect(screen.getByTestId('message-activity-list')).toHaveAttribute(
          'data-filters',
          JSON.stringify({}),
        );
      }
    });
  });

  describe('message drawer interaction', () => {
    beforeEach(() => {
      mockUseSelectedProject.mockReturnValue({
        selectedProject: { id: 'project-1', name: 'Test Project' },
      });
    });

    it('should open drawer when message is clicked', async () => {
      render(<MessagesPage />);

      fireEvent.click(screen.getByText('Message Row'));

      expect(screen.getByTestId('message-detail-drawer')).toHaveAttribute('data-open', 'true');
      expect(screen.getByText('Message: msg-1')).toBeInTheDocument();

      {
        fireEvent.click(screen.getByText('Message Row'));
        expect(screen.getByTestId('message-detail-drawer')).toHaveAttribute('data-open', 'true');
        fireEvent.click(screen.getByText('Close Drawer'));
        expect(screen.getByTestId('message-detail-drawer')).toHaveAttribute('data-open', 'false');
      }
    });
  });
});
