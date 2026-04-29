import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentRow } from './AgentRow';
import type { AgentOrGuest } from '@/ui/hooks/useChatQueries';

interface GlobalWithDOMRect extends Global {
  DOMRect?: typeof DOMRect;
}

if (!(global as GlobalWithDOMRect).DOMRect) {
  (global as GlobalWithDOMRect).DOMRect = class DOMRect {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    left: number;
    right: number;
    bottom: number;

    constructor(x = 0, y = 0, width = 0, height = 0) {
      this.x = x;
      this.y = y;
      this.width = width;
      this.height = height;
      this.top = y;
      this.left = x;
      this.right = x + width;
      this.bottom = y + height;
    }

    toJSON() {
      return this;
    }

    static fromRect(rect: Partial<{ x: number; y: number; width: number; height: number }> = {}) {
      const { x = 0, y = 0, width = 0, height = 0 } = rect;
      return new DOMRect(x, y, width, height);
    }
  };
}

if (!(global as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver) {
  class ResizeObserverMock {
    observe = jest.fn();
    unobserve = jest.fn();
    disconnect = jest.fn();
  }

  (
    global as unknown as {
      ResizeObserver?: typeof ResizeObserver;
    }
  ).ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
}

const agent: AgentOrGuest = {
  id: 'agent-1',
  name: 'Alpha',
  profileId: 'profile-1',
};

function renderAgentRow(overrides: Partial<React.ComponentProps<typeof AgentRow>> = {}) {
  const onClick = jest.fn();
  const onRestart = jest.fn();
  const onLaunch = jest.fn();
  const onTerminate = jest.fn();
  const onToggleContextTracking = jest.fn();

  const utils = render(
    <AgentRow
      agent={agent}
      isSelected={false}
      isOnline={true}
      activityState="busy"
      currentActivityTitle="Reviewing code"
      sessionMetrics={undefined}
      pendingRestart={false}
      providerIconUri="data:image/svg+xml;base64,PHN2Zy8+"
      providerName="Claude"
      configDisplayName="Sonnet"
      contextTrackingEnabled={true}
      hasSelectedProject={true}
      hasSession={false}
      sessionId={null}
      isLaunching={false}
      isRestarting={false}
      isLaunchingChat={false}
      activityBadge={<span>Busy 10s</span>}
      providerConfigSubmenu={<div>Provider Config</div>}
      onClick={onClick}
      onRestart={onRestart}
      onLaunch={onLaunch}
      onTerminate={onTerminate}
      onToggleContextTracking={onToggleContextTracking}
      {...overrides}
    />,
  );

  return { ...utils, onClick, onRestart, onLaunch, onTerminate, onToggleContextTracking };
}

describe('AgentRow', () => {
  it('renders agent name, online indicator, provider icon, and activity badge', () => {
    const { container } = renderAgentRow();

    expect(screen.getByLabelText(/Chat with Alpha \(online\)/i)).toBeInTheDocument();
    expect(screen.getByText('Busy 10s')).toBeInTheDocument();
    expect(screen.getByTitle('Provider: Claude')).toBeInTheDocument();
    expect(screen.getByText('Reviewing code')).toBeInTheDocument();
    expect(container.querySelector('svg.lucide-circle.text-green-500')).not.toBeNull();
  });

  it('fires onClick when the row is clicked', () => {
    const { onClick } = renderAgentRow();

    fireEvent.click(screen.getByLabelText(/Chat with Alpha \(online\)/i));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders the context menu on right click', async () => {
    renderAgentRow();

    fireEvent.contextMenu(screen.getByLabelText(/Chat with Alpha \(online\)/i));

    await waitFor(() => {
      expect(screen.getByText('Provider Config')).toBeInTheDocument();
    });
    expect(screen.getByRole('menuitemcheckbox', { name: /Context tracking/i })).toBeInTheDocument();
    expect(screen.getByText(/Launch session/i)).toBeInTheDocument();
  });

  it('marks the row as selected when isSelected is true', () => {
    renderAgentRow({ isSelected: true });

    expect(screen.getByLabelText(/Chat with Alpha \(online\)/i)).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('shows Clone menu item when canClone is true', async () => {
    const onClone = jest.fn();
    renderAgentRow({ canClone: true, onClone });

    fireEvent.contextMenu(screen.getByLabelText(/Chat with Alpha/i));

    await waitFor(() => {
      expect(screen.getByText('Clone')).toBeInTheDocument();
    });
  });

  it('does not show Clone menu item when canClone is false', async () => {
    renderAgentRow({ canClone: false });

    fireEvent.contextMenu(screen.getByLabelText(/Chat with Alpha/i));

    await waitFor(() => {
      expect(screen.getByText(/Context tracking/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('Clone')).not.toBeInTheDocument();
  });

  it('shows Delete menu item when canDelete is true', async () => {
    const onDelete = jest.fn();
    renderAgentRow({ canDelete: true, onDelete });

    fireEvent.contextMenu(screen.getByLabelText(/Chat with Alpha/i));

    await waitFor(() => {
      expect(screen.getByText('Delete')).toBeInTheDocument();
    });
  });

  it('does not show Delete menu item when canDelete is false', async () => {
    renderAgentRow({ canDelete: false });

    fireEvent.contextMenu(screen.getByLabelText(/Chat with Alpha/i));

    await waitFor(() => {
      expect(screen.getByText(/Context tracking/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('shows "Deleting…" and disables Delete when pendingDelete is true', async () => {
    const onDelete = jest.fn();
    renderAgentRow({ canDelete: true, onDelete, pendingDelete: true });

    fireEvent.contextMenu(screen.getByLabelText(/Chat with Alpha/i));

    await waitFor(() => {
      expect(screen.getByText('Deleting…')).toBeInTheDocument();
    });
  });
});
