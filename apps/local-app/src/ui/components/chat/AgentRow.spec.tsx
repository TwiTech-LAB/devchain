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
  const onOpenOverrides = jest.fn();
  const onReleaseHeldMessages = jest.fn();
  const onForceSend = jest.fn();

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
      canOverride={true}
      onOpenOverrides={onOpenOverrides}
      onReleaseHeldMessages={onReleaseHeldMessages}
      onForceSend={onForceSend}
      onClick={onClick}
      onRestart={onRestart}
      onLaunch={onLaunch}
      onTerminate={onTerminate}
      onToggleContextTracking={onToggleContextTracking}
      {...overrides}
    />,
  );

  return {
    ...utils,
    onClick,
    onRestart,
    onLaunch,
    onTerminate,
    onToggleContextTracking,
    onOpenOverrides,
    onReleaseHeldMessages,
    onForceSend,
  };
}

describe('AgentRow', () => {
  it('renders agent name, online provider icon, and activity badge', () => {
    const { container } = renderAgentRow();

    expect(screen.getByLabelText(/Open terminal for Alpha \(online\)/i)).toBeInTheDocument();
    expect(screen.getByText('Busy 10s')).toBeInTheDocument();
    const providerIconFrame = screen.getByTitle('Provider: Claude (online)');
    expect(providerIconFrame).toHaveClass(
      'h-6',
      'w-6',
      'bg-primary/10',
      'border-primary/60',
      'shadow-[0_0_8px_hsl(var(--primary)/0.35)]',
      'animate-busy-halo',
    );
    expect(providerIconFrame.querySelector('img')).toHaveClass('h-4', 'w-4');
    expect(providerIconFrame.querySelector('img')).not.toHaveClass('animate-spin');
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

    expect(screen.getByLabelText(/Open terminal for Alpha \(offline\)/i)).toBeInTheDocument();
    const providerIconFrame = screen.getByTitle('Provider: Claude (offline)');
    expect(providerIconFrame).toHaveClass('bg-muted/20', 'border-border/60');
    expect(providerIconFrame).not.toHaveClass('shadow-[0_0_8px_hsl(var(--primary)/0.35)]');
    expect(providerIconFrame.querySelector('img')).toHaveClass('grayscale', 'opacity-50');
    expect(providerIconFrame.querySelector('img')).not.toHaveClass('animate-spin');
    expect(screen.queryByText('Reviewing code')).not.toBeInTheDocument();
  });

  it('keeps the provider icon still while the online agent is idle', () => {
    renderAgentRow({
      activityState: 'idle',
      currentActivityTitle: null,
      activityBadge: undefined,
    });

    const providerIconFrame = screen.getByTitle('Provider: Claude (online)');
    expect(providerIconFrame).toHaveClass('bg-muted/40', 'border-border');
    expect(providerIconFrame).not.toHaveClass('shadow-[0_0_8px_hsl(var(--primary)/0.35)]');
    expect(providerIconFrame).not.toHaveClass('animate-busy-halo');
    expect(providerIconFrame.querySelector('img')).not.toHaveClass('animate-spin');
  });

  it('Copilot provider icon is decorative (alt="" + aria-hidden) — the adjacent agent name is the accessible label', () => {
    renderAgentRow({ providerName: 'copilot' });

    const providerIconFrame = screen.getByTitle('Provider: copilot (online)');
    const img = providerIconFrame.querySelector('img');
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('aria-hidden', 'true');
    // The agent name is rendered as adjacent visible text — the row is not icon-only.
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });

  it('fires onClick when the row is clicked', () => {
    const { onClick } = renderAgentRow();

    fireEvent.click(screen.getByLabelText(/Open terminal for Alpha \(online\)/i));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders the context menu on right click', async () => {
    renderAgentRow();

    fireEvent.contextMenu(screen.getByLabelText(/Open terminal for Alpha \(online\)/i));

    await waitFor(() => {
      expect(screen.getByText('Overrides…')).toBeInTheDocument();
    });
    expect(screen.getByRole('menuitemcheckbox', { name: /Context tracking/i })).toBeInTheDocument();
    expect(screen.getByText(/Launch session/i)).toBeInTheDocument();
  });

  it('fires onOpenOverrides with the row trigger from the context menu', async () => {
    const { onOpenOverrides } = renderAgentRow();

    fireEvent.contextMenu(screen.getByLabelText(/Open terminal for Alpha/i));

    fireEvent.click(await screen.findByText('Overrides…'));

    expect(onOpenOverrides).toHaveBeenCalledTimes(1);
    // Receives an element (the row trigger) so the dialog can restore focus.
    expect(onOpenOverrides.mock.calls[0][0]).toBeInstanceOf(HTMLElement);
  });

  // Layer: UI component (jsdom). Rendering AgentRow is the cheapest reliable
  // proof that its composed refs share one DOM node and preserve context-menu
  // focus ownership without mounting the full sidebar.
  it('composes the event-bus anchor ref with the overrides trigger ref', async () => {
    const anchorRef = jest.fn();
    const { onOpenOverrides, unmount } = renderAgentRow({
      anchorRef,
      eventBusAnchor: {
        key: 'team-1:agent-1',
        agentId: 'agent-1',
        teamId: 'team-1',
      },
    });
    const row = screen.getByLabelText(/Open terminal for Alpha/i);

    expect(anchorRef).toHaveBeenCalledWith(row);
    expect(row).toHaveAttribute('data-agent-event-bus-key', 'team-1:agent-1');
    expect(row).toHaveAttribute('data-agent-event-bus-agent-id', 'agent-1');
    expect(row).toHaveAttribute('data-agent-event-bus-team-id', 'team-1');

    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText('Overrides…'));
    expect(onOpenOverrides).toHaveBeenCalledWith(row);

    unmount();
    expect(anchorRef).toHaveBeenLastCalledWith(null);
  });

  it('hides the Overrides item when canOverride is false', async () => {
    renderAgentRow({ canOverride: false });

    fireEvent.contextMenu(screen.getByLabelText(/Open terminal for Alpha/i));

    await waitFor(() => {
      expect(screen.getByText(/Context tracking/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('Overrides…')).not.toBeInTheDocument();
  });

  it('marks the row as selected when isSelected is true', () => {
    renderAgentRow({ isSelected: true });

    expect(screen.getByLabelText(/Open terminal for Alpha \(online\)/i)).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByLabelText(/Open terminal for Alpha \(online\)/i)).toHaveClass(
      'border-border',
      'border-r-primary',
      'bg-muted',
    );
  });

  it('uses a subtle accent surface for team leads', () => {
    renderAgentRow({ isTeamLead: true });

    expect(screen.getByLabelText(/Open terminal for Alpha \(online\)/i)).toHaveClass(
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

    fireEvent.contextMenu(screen.getByLabelText(/Open terminal for Alpha/i));

    const cloneItem = await screen.findByText('Clone');
    fireEvent.click(cloneItem);
    expect(onClone).toHaveBeenCalledTimes(1);
  });

  it('does not show Clone menu item when canClone is false', async () => {
    renderAgentRow({ canClone: false });

    fireEvent.contextMenu(screen.getByLabelText(/Open terminal for Alpha/i));

    await waitFor(() => {
      expect(screen.getByText(/Context tracking/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('Clone')).not.toBeInTheDocument();
  });

  it('shows Delete menu item when canDelete is true', async () => {
    const onDelete = jest.fn();
    renderAgentRow({ canDelete: true, onDelete });

    fireEvent.contextMenu(screen.getByLabelText(/Open terminal for Alpha/i));

    const deleteItem = await screen.findByText('Delete');
    fireEvent.click(deleteItem);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('does not show Delete menu item when canDelete is false', async () => {
    renderAgentRow({ canDelete: false });

    fireEvent.contextMenu(screen.getByLabelText(/Open terminal for Alpha/i));

    await waitFor(() => {
      expect(screen.getByText(/Context tracking/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('shows "Deleting…" and disables Delete when pendingDelete is true', async () => {
    const onDelete = jest.fn();
    renderAgentRow({ canDelete: true, onDelete, pendingDelete: true });

    fireEvent.contextMenu(screen.getByLabelText(/Open terminal for Alpha/i));

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

    fireEvent.contextMenu(screen.getByLabelText(/Open terminal for Alpha/i));

    fireEvent.click(await screen.findByText('Edit team'));

    expect(onEditTeam).toHaveBeenCalledTimes(1);
  });

  it('fires context tracking toggle from the context menu', async () => {
    const { onToggleContextTracking } = renderAgentRow();

    fireEvent.contextMenu(screen.getByLabelText(/Open terminal for Alpha/i));

    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Context tracking/i }));

    expect(onToggleContextTracking).toHaveBeenCalledTimes(1);
  });

  it('fires restart and launch session actions from the context menu', async () => {
    const { onRestart, onLaunch } = renderAgentRow({ hasSession: false, sessionId: null });

    fireEvent.contextMenu(screen.getByLabelText(/Open terminal for Alpha/i));

    fireEvent.click(await screen.findByText('Restart session'));
    fireEvent.click(screen.getByText('Launch session'));

    await waitFor(() => {
      expect(onRestart).toHaveBeenCalledTimes(1);
      expect(onLaunch).toHaveBeenCalledTimes(1);
    });
  });

  it('fires terminate session action when an active session exists', async () => {
    const { onTerminate } = renderAgentRow({ hasSession: true, sessionId: 'session-1' });

    fireEvent.contextMenu(screen.getByLabelText(/Open terminal for Alpha/i));

    fireEvent.click(await screen.findByText('Terminate session'));

    expect(onTerminate).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Launch session')).not.toBeInTheDocument();
  });

  describe('human-held message badge', () => {
    it('shows a compact plural waiting badge and extends the accessible name', () => {
      renderAgentRow({ humanHeldMessageCount: 2, canReleaseHeldMessages: true });

      const row = screen.getByLabelText(
        'Open terminal for Alpha (online), 2 messages waiting for you to finish typing',
      );
      expect(row).toBeInTheDocument();
      expect(screen.getByText('2 waiting')).toBeInTheDocument();
    });

    it('opens the release confirmation action without selecting the agent row', () => {
      const { onClick, onReleaseHeldMessages } = renderAgentRow({
        humanHeldMessageCount: 2,
        canReleaseHeldMessages: true,
      });

      fireEvent.click(screen.getByRole('button', { name: 'Release 2 queued messages for Alpha' }));

      expect(onReleaseHeldMessages).toHaveBeenCalledTimes(1);
      expect(onClick).not.toHaveBeenCalled();
    });

    it('shows only the count before the release action becomes eligible', () => {
      renderAgentRow({ humanHeldMessageCount: 2, canReleaseHeldMessages: false });

      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.queryByText('2 waiting')).not.toBeInTheDocument();
      expect(screen.queryByText('Busy 10s')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Release 2 queued messages for Alpha' }),
      ).not.toBeInTheDocument();
    });

    it('replaces the activity timer with the clickable waiting badge after eligibility', () => {
      renderAgentRow({ humanHeldMessageCount: 2, canReleaseHeldMessages: true });

      expect(screen.getByText('2 waiting')).toBeInTheDocument();
      expect(screen.queryByText('Busy 10s')).not.toBeInTheDocument();
    });

    it('uses singular wording for a single held message', () => {
      renderAgentRow({ humanHeldMessageCount: 1, canReleaseHeldMessages: true });

      expect(
        screen.getByLabelText(
          'Open terminal for Alpha (online), 1 message waiting for you to finish typing',
        ),
      ).toBeInTheDocument();
      expect(screen.getByText('1 waiting')).toBeInTheDocument();
    });

    it('renders no badge and keeps the base accessible name when nothing is held', () => {
      renderAgentRow({ humanHeldMessageCount: 0 });

      expect(screen.getByLabelText('Open terminal for Alpha (online)')).toBeInTheDocument();
      expect(screen.queryByText(/waiting/i)).not.toBeInTheDocument();
    });

    it('defaults to no badge when the count is not provided', () => {
      renderAgentRow();

      expect(screen.getByLabelText('Open terminal for Alpha (online)')).toBeInTheDocument();
      expect(screen.queryByText(/waiting/i)).not.toBeInTheDocument();
    });
  });

  describe('force send button', () => {
    it('shows Send now when canForceSend is true and humanHeldMessageCount is positive', () => {
      renderAgentRow({ humanHeldMessageCount: 1, canForceSend: true });

      expect(screen.getByRole('button', { name: 'Send now for Alpha' })).toBeInTheDocument();
    });

    it('shows Send now when canForceSend is true and humanHeldMessageCount is 0', () => {
      renderAgentRow({ humanHeldMessageCount: 0, canForceSend: true });

      expect(screen.getByRole('button', { name: 'Send now for Alpha' })).toBeInTheDocument();
    });

    it('hides Send now for draft_active (canForceSend false)', () => {
      renderAgentRow({
        humanHeldMessageCount: 2,
        canReleaseHeldMessages: true,
        canForceSend: false,
      });

      expect(screen.queryByRole('button', { name: 'Send now for Alpha' })).not.toBeInTheDocument();
      expect(screen.getByText('2 waiting')).toBeInTheDocument();
    });

    it('fires onForceSend without selecting the agent row', () => {
      const { onClick, onForceSend } = renderAgentRow({ canForceSend: true });

      fireEvent.click(screen.getByRole('button', { name: 'Send now for Alpha' }));

      expect(onForceSend).toHaveBeenCalledTimes(1);
      expect(onClick).not.toHaveBeenCalled();
    });

    it('disables Send now while force is pending', () => {
      renderAgentRow({ canForceSend: true, forceSending: true });

      expect(screen.getByRole('button', { name: 'Send now for Alpha' })).toBeDisabled();
    });

    it('hides the count badge when canForceSend is true even with held messages', () => {
      renderAgentRow({ humanHeldMessageCount: 1, canForceSend: true });

      expect(screen.queryByText('1')).not.toBeInTheDocument();
    });

    it('shows hold-reason label before force threshold for non-draft holds', () => {
      renderAgentRow({
        humanHeldMessageCount: 0,
        canForceSend: false,
        holdReasonLabel: 'Waiting for provider idle',
      });

      expect(screen.getByText('Waiting for provider idle')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Send now for Alpha' })).not.toBeInTheDocument();
    });

    it('hides hold-reason label when force is eligible', () => {
      renderAgentRow({
        humanHeldMessageCount: 0,
        canForceSend: true,
        holdReasonLabel: 'Waiting for terminal quiet',
      });

      expect(screen.queryByText('Waiting for terminal quiet')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send now for Alpha' })).toBeInTheDocument();
    });
  });

  describe('unlogged time marker', () => {
    function marker(row: HTMLElement): HTMLElement | null {
      return row.querySelector('[data-unlogged-time-marker]');
    }

    it('renders a non-interactive half-height amber fade over the right rail', () => {
      renderAgentRow({ unloggedTimeMinutes: 10 });

      const row = screen.getByRole('listitem');
      const accent = marker(row);
      expect(accent).not.toBeNull();
      expect(accent).toHaveAttribute('aria-hidden', 'true');
      expect(accent.className).toContain('pointer-events-none');
      expect(accent.className).toContain('-right-0.5');
      expect(accent.className).toContain('top-0');
      expect(accent.className).toContain('h-1/2');
      expect(accent.className).toContain('w-0.5');
      expect(accent.className).toContain('bg-gradient-to-b');
      expect(accent.className).toContain('from-amber-700');
      expect(accent.className).toContain('to-transparent');
      // The accent is a plain span; the row gains no nested interactive control.
      expect(accent!.querySelector('button, [role="button"], a')).toBeNull();
      expect(row.tagName).toBe('BUTTON');
      expect(row.querySelectorAll('button')).toHaveLength(0);
    });

    it('extends the row aria-label with the exact unlogged phrase', () => {
      renderAgentRow({ unloggedTimeMinutes: 90 });

      expect(
        screen.getByLabelText('Open terminal for Alpha (online), 1h 30m not logged to an Epic.'),
      ).toBeInTheDocument();
    });

    it('hides the marker and label extension below ten minutes and when absent', () => {
      const first = renderAgentRow({ unloggedTimeMinutes: 9 });
      expect(marker(screen.getByRole('listitem'))).toBeNull();
      expect(screen.getByLabelText('Open terminal for Alpha (online)')).toBeInTheDocument();
      first.unmount();

      renderAgentRow();
      expect(marker(screen.getByRole('listitem'))).toBeNull();
      expect(screen.getByLabelText('Open terminal for Alpha (online)')).toBeInTheDocument();
      expect(screen.getByRole('listitem').className).not.toContain('relative');
    });

    it('overlays the selected rail without displacing the restart warning', () => {
      renderAgentRow({ unloggedTimeMinutes: 10, pendingRestart: true, isSelected: true });

      const row = screen.getByRole('listitem');
      expect(marker(row)).not.toBeNull();
      // The restart warning icon renders inline; its tooltip copy opens on
      // hover, so presence is asserted through the icon itself.
      expect(row.querySelector('svg.text-yellow-500')).not.toBeNull();
      // The amber fade overlays the top half; the full-height selected rail
      // remains blue underneath and visible through the transparent end.
      expect(row.className).toContain('relative');
      expect(row.className).toContain('border-r-primary');
      expect(row.className).not.toContain('pr-5');
    });

    it('keeps row clicks unchanged with the marker present', () => {
      const { onClick } = renderAgentRow({ unloggedTimeMinutes: 10 });

      fireEvent.click(screen.getByRole('listitem'));
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });
});
