import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InlineSessionSummaryChip, DEFAULT_CHIP_VISIBLE_ITEMS } from './InlineSessionSummaryChip';
import { InlineTerminalHeader } from '@/ui/components/chat/InlineTerminalHeader';
import type { UnifiedMetrics } from '@/modules/session-reader/dtos/unified-session.types';

// Polyfill DOMRect for Radix floating-ui in jsdom
if (typeof globalThis.DOMRect === 'undefined') {
  (globalThis as unknown as Record<string, unknown>).DOMRect = class DOMRect {
    x = 0;
    y = 0;
    width = 0;
    height = 0;
    top = 0;
    bottom = 0;
    left = 0;
    toJSON() {
      return {};
    }
    static fromRect() {
      return new DOMRect();
    }
  };
}

function makeMetrics(overrides: Partial<UnifiedMetrics> = {}): UnifiedMetrics {
  return {
    inputTokens: 1200,
    outputTokens: 800,
    cacheReadTokens: 300,
    cacheCreationTokens: 100,
    totalTokens: 2400,
    totalContextConsumption: 500,
    compactionCount: 0,
    phaseBreakdowns: [],
    visibleContextTokens: 50_000,
    totalContextTokens: 100_000,
    contextWindowTokens: 200_000,
    costUsd: 0.035,
    primaryModel: 'claude-sonnet-4-6',
    durationMs: 15_000,
    messageCount: 6,
    isOngoing: false,
    ...overrides,
  };
}

function renderHeaderWithChip(
  withChip: boolean,
  unloggedTime?: { minutes: number; onAssign: () => void } | null,
): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <InlineTerminalHeader
        agentName="Coder"
        hasTranscript
        onTabChange={jest.fn()}
        sessionChip={
          withChip
            ? {
                metrics: makeMetrics(),
                activeTab: 'terminal',
                onSwitchToSession: jest.fn(),
              }
            : undefined
        }
        unloggedTime={unloggedTime ?? null}
      />
    </QueryClientProvider>,
  );
  // The header root is the only element carrying tabIndex -1.
  return document.querySelector('[tabindex="-1"]') as HTMLElement;
}

async function openHeaderMenu(root: HTMLElement) {
  fireEvent.contextMenu(root);
  await waitFor(() => {
    expect(screen.getByText('Visible Items')).toBeInTheDocument();
  });
}

describe('InlineSessionSummaryChip', () => {
  const storageKey = 'devchain:chipVisibleItems';
  const defaultProps = {
    metrics: makeMetrics(),
    activeTab: 'terminal' as const,
    onSwitchToSession: jest.fn(),
    visibleItems: DEFAULT_CHIP_VISIBLE_ITEMS,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.removeItem(storageKey);
    window.localStorage.removeItem('devchain:headerUnloggedTimeVisible');
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  it('should render compact token count and cost', () => {
    render(<InlineSessionSummaryChip {...defaultProps} />);

    const chip = screen.getByRole('button');
    expect(chip).toHaveTextContent('2.4k');
    expect(chip).toHaveTextContent('$0.04');
  });

  it('should show pulsing dot for ongoing sessions', () => {
    render(
      <InlineSessionSummaryChip {...defaultProps} metrics={makeMetrics({ isOngoing: true })} />,
    );

    const chip = screen.getByRole('button');
    const dot = chip.querySelector('span.animate-pulse');
    expect(dot).toBeTruthy();
  });

  it('should show static dot for completed sessions', () => {
    render(
      <InlineSessionSummaryChip {...defaultProps} metrics={makeMetrics({ isOngoing: false })} />,
    );

    const chip = screen.getByRole('button');
    const pulseDot = chip.querySelector('span.animate-pulse');
    expect(pulseDot).toBeNull();
  });

  it('should have accessible aria-label with metrics summary', () => {
    render(
      <InlineSessionSummaryChip {...defaultProps} metrics={makeMetrics({ isOngoing: true })} />,
    );

    const chip = screen.getByRole('button');
    expect(chip).toHaveAttribute('aria-label', expect.stringContaining('2.4k tokens'));
    expect(chip).toHaveAttribute('aria-label', expect.stringContaining('ongoing'));
  });

  it('should not render its own context menu or menu button semantics', () => {
    render(<InlineSessionSummaryChip {...defaultProps} />);

    const chip = screen.getByRole('button');
    expect(chip).not.toHaveAttribute('aria-haspopup');
    expect(chip).not.toHaveAttribute('aria-expanded');
  });

  // -------------------------------------------------------------------------
  // Token formatting
  // -------------------------------------------------------------------------

  it('should format tokens below 1k as plain numbers', () => {
    render(
      <InlineSessionSummaryChip {...defaultProps} metrics={makeMetrics({ totalTokens: 500 })} />,
    );
    expect(screen.getByRole('button')).toHaveTextContent('500');
  });

  it('should format tokens in thousands with one decimal', () => {
    render(
      <InlineSessionSummaryChip {...defaultProps} metrics={makeMetrics({ totalTokens: 1500 })} />,
    );
    expect(screen.getByRole('button')).toHaveTextContent('1.5k');
  });

  it('should format tokens above 10k as rounded thousands', () => {
    render(
      <InlineSessionSummaryChip {...defaultProps} metrics={makeMetrics({ totalTokens: 15_200 })} />,
    );
    expect(screen.getByRole('button')).toHaveTextContent('15k');
  });

  it('should format tokens in millions', () => {
    render(
      <InlineSessionSummaryChip
        {...defaultProps}
        metrics={makeMetrics({ totalTokens: 2_300_000 })}
      />,
    );
    expect(screen.getByRole('button')).toHaveTextContent('2.3M');
  });

  // -------------------------------------------------------------------------
  // Cost formatting
  // -------------------------------------------------------------------------

  it('should format zero cost', () => {
    render(<InlineSessionSummaryChip {...defaultProps} metrics={makeMetrics({ costUsd: 0 })} />);
    expect(screen.getByRole('button')).toHaveTextContent('$0');
  });

  it('should format small costs with 4 decimal places', () => {
    render(
      <InlineSessionSummaryChip {...defaultProps} metrics={makeMetrics({ costUsd: 0.0012 })} />,
    );
    expect(screen.getByRole('button')).toHaveTextContent('$0.0012');
  });

  // -------------------------------------------------------------------------
  // Click behavior
  // -------------------------------------------------------------------------

  it('should call onSwitchToSession when clicked on Terminal tab', () => {
    const onSwitch = jest.fn();
    render(
      <InlineSessionSummaryChip
        {...defaultProps}
        activeTab="terminal"
        onSwitchToSession={onSwitch}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });

  it('should NOT call onSwitchToSession when clicked on Session tab', () => {
    const onSwitch = jest.fn();
    render(
      <InlineSessionSummaryChip
        {...defaultProps}
        activeTab="session"
        onSwitchToSession={onSwitch}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(onSwitch).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Inline metrics
  // -------------------------------------------------------------------------

  it('should show context percentage inline', () => {
    render(
      <InlineSessionSummaryChip
        {...defaultProps}
        activeTab="session"
        metrics={makeMetrics({ visibleContextTokens: 50_000, contextWindowTokens: 200_000 })}
      />,
    );

    expect(screen.getByRole('button')).toHaveTextContent('50%');
  });

  it('should show window percentage badge (not visible/total percentage)', () => {
    render(
      <InlineSessionSummaryChip
        {...defaultProps}
        activeTab="session"
        metrics={makeMetrics({
          visibleContextTokens: 90_000, // visible/total = 90%
          totalContextTokens: 100_000, // window usage = 50%
          contextWindowTokens: 200_000,
        })}
      />,
    );

    const chip = screen.getByRole('button');
    expect(chip).toHaveTextContent('50%');
    expect(chip).not.toHaveTextContent('90%');
  });

  it('should keep model always visible and include all metrics in aria-label', () => {
    render(
      <InlineSessionSummaryChip
        {...defaultProps}
        activeTab="session"
        metrics={makeMetrics({
          primaryModel: 'claude-sonnet-4-6',
          modelsUsed: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
        })}
      />,
    );

    const chip = screen.getByRole('button');
    expect(chip).toHaveTextContent('claude-sonnet-4-6');
    expect(chip).toHaveAttribute('aria-label', expect.stringContaining('plus 1 more'));
    expect(chip).toHaveAttribute('aria-label', expect.stringContaining('context window 50% used'));
    expect(chip).toHaveAttribute('aria-label', expect.stringContaining('compactions 0'));
  });

  it('should apply model truncation classes', () => {
    const longModel = 'claude-sonnet-4-6-very-long-model-name-with-extra-segments-20260225';
    render(
      <InlineSessionSummaryChip
        {...defaultProps}
        activeTab="session"
        metrics={makeMetrics({ primaryModel: longModel })}
      />,
    );

    const chip = screen.getByRole('button');
    const modelSpan = chip.querySelector(`span[title="${longModel}"]`);
    expect(modelSpan).toHaveClass('truncate', 'max-w-[120px]');
    expect(chip).toHaveTextContent(longModel);
  });

  it('should show compaction count only when > 0', () => {
    const { unmount } = render(
      <InlineSessionSummaryChip
        {...defaultProps}
        activeTab="session"
        metrics={makeMetrics({ compactionCount: 0 })}
      />,
    );

    expect(screen.getByRole('button')).not.toHaveTextContent('compaction');
    unmount();

    render(
      <InlineSessionSummaryChip
        {...defaultProps}
        activeTab="session"
        metrics={makeMetrics({ compactionCount: 3 })}
      />,
    );

    expect(screen.getByRole('button')).toHaveTextContent('3 compactions');
  });

  it('should use fallback 200k context window when contextWindowTokens is 0', () => {
    render(
      <InlineSessionSummaryChip
        {...defaultProps}
        activeTab="session"
        metrics={makeMetrics({ visibleContextTokens: 50_000, contextWindowTokens: 0 })}
      />,
    );

    expect(screen.getByRole('button')).toHaveTextContent('50%');
  });

  // -------------------------------------------------------------------------
  // Controlled visibleItems (the header's Visible Items menu owns the state)
  // -------------------------------------------------------------------------

  it('should hide controlled metric parts when visibleItems disables them', () => {
    render(
      <InlineSessionSummaryChip
        {...defaultProps}
        metrics={makeMetrics({ compactionCount: 3 })}
        visibleItems={{ tokens: false, cost: true, context: false, compactions: false }}
      />,
    );

    const chip = screen.getByRole('button');
    expect(chip).not.toHaveTextContent('2.4k');
    expect(chip).toHaveTextContent('$0.04');
    expect(chip).not.toHaveTextContent('50%');
    expect(chip).not.toHaveTextContent('compaction');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('should keep model and status dot visible when all metric items are disabled', () => {
    render(
      <InlineSessionSummaryChip
        {...defaultProps}
        metrics={makeMetrics({ compactionCount: 4, isOngoing: true })}
        visibleItems={{ tokens: false, cost: false, context: false, compactions: false }}
      />,
    );

    const chip = screen.getByRole('button');
    expect(chip).toHaveTextContent('claude-sonnet-4-6');
    expect(chip).not.toHaveTextContent('2.4k');
    expect(chip).not.toHaveTextContent('$0.04');
    expect(chip).not.toHaveTextContent('compaction');
    expect(chip).not.toHaveTextContent('50%');

    const statusDot = chip.querySelector('span.animate-pulse');
    expect(statusDot).toBeTruthy();
  });

  it('should keep aria-label comprehensive even when metrics are hidden by prefs', () => {
    render(
      <InlineSessionSummaryChip
        {...defaultProps}
        visibleItems={{ tokens: false, cost: false, context: false, compactions: true }}
      />,
    );
    const chip = screen.getByRole('button');

    expect(chip).toHaveAttribute('aria-label', expect.stringContaining('total 2.4k tokens'));
    expect(chip).toHaveAttribute('aria-label', expect.stringContaining('cost $0.04'));
    expect(chip).toHaveAttribute('aria-label', expect.stringContaining('context window 50% used'));
    expect(chip).toHaveAttribute('aria-label', expect.stringContaining('compactions 0'));
  });

  // -------------------------------------------------------------------------
  // Header-root Visible Items menu: admission, checkboxes, Shift+F10
  // -------------------------------------------------------------------------

  it('opens the Visible Items menu from the header root with the four metric items', async () => {
    const root = renderHeaderWithChip(true);

    await openHeaderMenu(root);
    expect(screen.getByText('Tokens')).toBeInTheDocument();
    expect(screen.getByText('Cost')).toBeInTheDocument();
    expect(screen.getByText('Context')).toBeInTheDocument();
    expect(screen.getByText('Compactions')).toBeInTheDocument();
    expect(screen.queryByText('Unlogged time')).not.toBeInTheDocument();
  });

  it('admits the menu without metrics and without unlogged capability', async () => {
    const root = renderHeaderWithChip(false);

    await openHeaderMenu(root);
    expect(screen.getByText('Visible Items')).toBeInTheDocument();
    expect(screen.queryByText('Tokens')).not.toBeInTheDocument();
    expect(screen.queryByText('Unlogged time')).not.toBeInTheDocument();
  });

  it('shows the Unlogged time checkbox only when the header declares capability', async () => {
    const root = renderHeaderWithChip(true, { minutes: 0, onAssign: jest.fn() });

    await openHeaderMenu(root);
    expect(screen.getByText('Unlogged time')).toBeInTheDocument();
  });

  it('controls chip parts and persists prefs through the header menu checkboxes', async () => {
    const root = renderHeaderWithChip(true);
    // Capture the chip before the menu opens: Radix hides outside content
    // from the accessibility tree while the menu is open.
    const chip = screen.getByRole('button', {
      name: /Session metrics: model claude-sonnet-4-6/,
    });
    expect(chip).toHaveTextContent('2.4k');

    await openHeaderMenu(root);
    fireEvent.click(screen.getByText('Tokens'));
    await waitFor(() => {
      expect(chip).not.toHaveTextContent('2.4k');
    });
    expect(window.localStorage.getItem(storageKey)).toContain('"tokens":false');
  });

  it('toggles cost and context chip parts through the header menu', async () => {
    const root = renderHeaderWithChip(true);
    const chip = screen.getByRole('button', {
      name: /Session metrics: model claude-sonnet-4-6/,
    });

    await openHeaderMenu(root);
    fireEvent.click(screen.getByText('Cost'));
    await waitFor(() => {
      expect(chip).not.toHaveTextContent('$0.04');
    });

    await openHeaderMenu(root);
    fireEvent.click(screen.getByText('Context'));
    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });
  });

  it('opens the header menu via Shift+F10 from the keyboard', async () => {
    const root = renderHeaderWithChip(true);

    fireEvent.keyDown(root, { key: 'F10', shiftKey: true });

    await waitFor(() => {
      expect(screen.getByText('Visible Items')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Context bar colors
  // -------------------------------------------------------------------------

  it('should render green context bar at <=50% window usage', () => {
    render(
      <InlineSessionSummaryChip
        {...defaultProps}
        metrics={makeMetrics({ totalContextTokens: 100_000, contextWindowTokens: 200_000 })}
      />,
    );

    const progressBar = screen.getByRole('progressbar');
    const fill = progressBar.firstElementChild as HTMLElement;
    expect(fill.className).toContain('bg-primary/60');
    expect(fill.style.width).toBe('50%');
    expect(progressBar).toHaveAttribute('aria-valuenow', '50');
    expect(progressBar).toHaveAttribute('aria-valuemin', '0');
    expect(progressBar).toHaveAttribute('aria-valuemax', '100');
  });

  it('should render amber context bar at 51-80% window usage', () => {
    render(
      <InlineSessionSummaryChip
        {...defaultProps}
        metrics={makeMetrics({ totalContextTokens: 120_000, contextWindowTokens: 200_000 })}
      />,
    );

    const progressBar = screen.getByRole('progressbar');
    const fill = progressBar.firstElementChild as HTMLElement;
    expect(fill.className).toContain('bg-amber-500');
    expect(fill.style.width).toBe('60%');
    expect(progressBar).toHaveAttribute('aria-valuenow', '60');
  });

  it('should render red context bar at >80% window usage', () => {
    render(
      <InlineSessionSummaryChip
        {...defaultProps}
        metrics={makeMetrics({ totalContextTokens: 190_000, contextWindowTokens: 200_000 })}
      />,
    );

    const progressBar = screen.getByRole('progressbar');
    const fill = progressBar.firstElementChild as HTMLElement;
    expect(fill.className).toContain('bg-destructive');
    expect(fill.style.width).toBe('95%');
    expect(progressBar).toHaveAttribute('aria-valuenow', '95');
  });

  it('should clamp progress bar width and aria-valuenow at 100%', () => {
    render(
      <InlineSessionSummaryChip
        {...defaultProps}
        metrics={makeMetrics({ totalContextTokens: 400_000, contextWindowTokens: 200_000 })}
      />,
    );

    const progressBar = screen.getByRole('progressbar');
    const fill = progressBar.firstElementChild as HTMLElement;
    expect(fill.style.width).toBe('100%');
    expect(progressBar).toHaveAttribute('aria-valuenow', '100');
  });

  it('should render correct percentage with 1M context window', () => {
    render(
      <InlineSessionSummaryChip
        {...defaultProps}
        metrics={makeMetrics({ totalContextTokens: 100_000, contextWindowTokens: 1_000_000 })}
      />,
    );

    const chip = screen.getByRole('button');
    expect(chip).toHaveAttribute('aria-label', expect.stringContaining('context window 10% used'));

    const progressBar = screen.getByRole('progressbar');
    expect(progressBar).toHaveAttribute('aria-valuenow', '10');
  });

  // -------------------------------------------------------------------------
  // Tooltip
  // -------------------------------------------------------------------------

  it('should show tooltip on hover', async () => {
    render(<InlineSessionSummaryChip {...defaultProps} />);
    const chip = screen.getByRole('button');

    jest.useFakeTimers();
    try {
      fireEvent.pointerMove(chip);
      act(() => {
        jest.advanceTimersByTime(350);
      });

      await waitFor(() => {
        expect(screen.getAllByText('Session Metrics').length).toBeGreaterThan(0);
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('should show visible, total, and window context metrics in tooltip', async () => {
    render(
      <InlineSessionSummaryChip
        {...defaultProps}
        metrics={makeMetrics({
          visibleContextTokens: 86_700,
          totalContextTokens: 136_000,
          contextWindowTokens: 200_000,
        })}
      />,
    );
    const chip = screen.getByRole('button');

    jest.useFakeTimers();
    try {
      fireEvent.pointerMove(chip);
      act(() => {
        jest.advanceTimersByTime(350);
      });

      await waitFor(() => {
        expect(screen.getAllByText('Session Metrics').length).toBeGreaterThan(0);
      });
    } finally {
      jest.useRealTimers();
    }

    expect(screen.getAllByText('Visible Context').length).toBeGreaterThan(0);
    expect(screen.getAllByText('87k (64% of total)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Total Context').length).toBeGreaterThan(0);
    expect(screen.getAllByText('136k').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Context Window').length).toBeGreaterThan(0);
    expect(screen.getAllByText('68% used (of 200k)').length).toBeGreaterThan(0);
  });

  it('should not crash when window is undefined during SSR initialization', () => {
    const originalWindow = (globalThis as unknown as { window?: Window }).window;
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      (globalThis as unknown as { window?: Window }).window = undefined;
      expect(() =>
        renderToString(
          <InlineSessionSummaryChip
            metrics={makeMetrics()}
            activeTab="terminal"
            onSwitchToSession={jest.fn()}
            visibleItems={DEFAULT_CHIP_VISIBLE_ITEMS}
          />,
        ),
      ).not.toThrow();
    } finally {
      consoleErrorSpy.mockRestore();
      (globalThis as unknown as { window?: Window }).window = originalWindow;
    }
  });
});
