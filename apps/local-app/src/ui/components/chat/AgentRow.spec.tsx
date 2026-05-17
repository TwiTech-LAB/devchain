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
  it('renders agent name, online provider icon, and activity badge', () => {
    const { container } = renderAgentRow();

    expect(screen.getByLabelText(/Chat with Alpha \(online\)/i)).toBeInTheDocument();
    expect(screen.getByText('Busy 10s')).toBeInTheDocument();
    const providerIconFrame = screen.getByTitle('Provider: Claude (online)');
    expect(providerIconFrame).toHaveClass('h-6', 'w-6', 'bg-muted/40', 'border-border');
    expect(providerIconFrame.querySelector('img')).toHaveClass('h-4', 'w-4');
    expect(providerIconFrame.querySelector('img')).not.toHaveClass('grayscale');
    expect(screen.getByText('Alpha')).toHaveClass('truncate', 'text-foreground');
    expect(screen.getByText('Sonnet')).toHaveClass('text-muted-foreground');
    expect(screen.queryByText('Alpha (Sonnet)')).not.toBeInTheDocument();
    expect(screen.getByText('Reviewing code')).toBeInTheDocument();
    expect(container.querySelector('svg.lucide-circle.text-green-500')).toBeNull();
  });

  it('uses a grayscaled provider icon for offline agents', () => {
    renderAgentRow({
      isOnline: false,
      activityState: null,
      currentActivityTitle: null,
      activityBadge: undefined,
    });

    expect(screen.getByLabelText(/Chat with Alpha \(offline\)/i)).toBeInTheDocument();
    const providerIconFrame = screen.getByTitle('Provider: Claude (offline)');
    expect(providerIconFrame).toHaveClass('bg-muted/20', 'border-border/60');
    expect(providerIconFrame.querySelector('img')).toHaveClass('grayscale', 'opacity-50');
    expect(screen.queryByText('Reviewing code')).not.toBeInTheDocument();
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
    expect(screen.getByLabelText(/Chat with Alpha \(online\)/i)).toHaveClass(
      'border-border',
      'border-r-primary',
      'bg-muted',
    );
  });

  it('uses a subtle accent surface for team leads', () => {
    renderAgentRow({ isTeamLead: true });

    expect(screen.getByLabelText(/Chat with Alpha \(online\)/i)).toHaveClass(
      'bg-primary/5',
      'hover:bg-primary/10',
    );
    expect(screen.getByText('Alpha')).toHaveClass('text-[#8f4f39]', 'dark:text-[#d08a67]');
  });

  it('keeps long agent names and config labels inline and truncated', () => {
    renderAgentRow({
      agent: {
        ...agent,
        name: 'Very Long Agent Name That Should Truncate Inside The Row',
      } as AgentOrGuest,
      configDisplayName: 'Provider Config With A Very Long Model Override Label',
    });

    expect(
      screen.getByText('Very Long Agent Name That Should Truncate Inside The Row'),
    ).toHaveClass('truncate');
    expect(screen.getByText('Provider Config With A Very Long Model Override Label')).toHaveClass(
      'max-w-[45%]',
      'truncate',
      'text-muted-foreground',
    );
  });

  it('shows Clone menu item when canClone is true', async () => {
    const onClone = jest.fn();
    renderAgentRow({ canClone: true, onClone });

    fireEvent.contextMenu(screen.getByLabelText(/Chat with Alpha/i));

    const cloneItem = await screen.findByText('Clone');
    fireEvent.click(cloneItem);
    expect(onClone).toHaveBeenCalledTimes(1);
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

    const deleteItem = await screen.findByText('Delete');
    fireEvent.click(deleteItem);
    expect(onDelete).toHaveBeenCalledTimes(1);
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

  it('fires edit team action from the context menu', async () => {
    const onEditTeam = jest.fn();
    renderAgentRow({
      canEditTeam: true,
      onEditTeam,
    });

    fireEvent.contextMenu(screen.getByLabelText(/Chat with Alpha/i));

    fireEvent.click(await screen.findByText('Edit team'));

    expect(onEditTeam).toHaveBeenCalledTimes(1);
  });

  it('fires context tracking toggle from the context menu', async () => {
    const { onToggleContextTracking } = renderAgentRow();

    fireEvent.contextMenu(screen.getByLabelText(/Chat with Alpha/i));

    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Context tracking/i }));

    expect(onToggleContextTracking).toHaveBeenCalledTimes(1);
  });

  it('fires restart and launch session actions from the context menu', async () => {
    const { onRestart, onLaunch } = renderAgentRow({ hasSession: false, sessionId: null });

    fireEvent.contextMenu(screen.getByLabelText(/Chat with Alpha/i));

    fireEvent.click(await screen.findByText('Restart session'));
    fireEvent.click(screen.getByText('Launch session'));

    await waitFor(() => {
      expect(onRestart).toHaveBeenCalledTimes(1);
      expect(onLaunch).toHaveBeenCalledTimes(1);
    });
  });

  it('fires terminate session action when an active session exists', async () => {
    const { onTerminate } = renderAgentRow({ hasSession: true, sessionId: 'session-1' });

    fireEvent.contextMenu(screen.getByLabelText(/Chat with Alpha/i));

    fireEvent.click(await screen.findByText('Terminate session'));

    expect(onTerminate).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Launch session')).not.toBeInTheDocument();
  });
});
