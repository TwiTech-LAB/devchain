import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { InlineSessionSummaryChip } from './InlineSessionSummaryChip';
import type { UnifiedMetrics } from '@/modules/session-reader/dtos/unified-session.types';

// Polyfill DOMRect for Radix floating-ui in jsdom
if (typeof globalThis.DOMRect === 'undefined') {
  (globalThis as unknown as Record<string, unknown>).DOMRect = class DOMRect {
    x = 0;
    y = 0;
    width = 0;
    height = 0;
    top = 0;
    right = 0;
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

describe('InlineSessionSummaryChip', () => {
  const storageKey = 'devchain:chipVisibleItems';
  const defaultProps = {
    metrics: makeMetrics(),
    activeTab: 'terminal' as const,
    onSwitchToSession: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.removeItem(storageKey);
  });

  async function openVisibilityMenu(chip: HTMLElement) {
    fireEvent.contextMenu(chip);
    await waitFor(() => {
      expect(screen.getByText('Visible Items')).toBeInTheDocument();
    });
  }

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

  it('should show visibility context menu on right click', async () => {
    render(
      <InlineSessionSummaryChip
        {...defaultProps}
        activeTab="session"
        onSwitchToSession={jest.fn()}
      />,
    );

    await openVisibilityMenu(screen.getByRole('button'));
    expect(screen.getByText('Tokens')).toBeInTheDocument();
    expect(screen.getByText('Cost')).toBeInTheDocument();
    expect(screen.getByText('Context')).toBeInTheDocument();
    expect(screen.getByText('Compactions')).toBeInTheDocument();
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
  // Inline metrics and context menu behavior
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

  it('should apply model truncation classes and not include model toggle in context menu', async () => {
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

    await openVisibilityMenu(chip);
    expect(screen.queryByText('Model')).not.toBeInTheDocument();
  });

  it('should show compaction count only when > 0', () => {
    // No compactions — should not show
    const { unmount } = render(
      <InlineSessionSummaryChip
        {...defaultProps}
        activeTab="session"
        metrics={makeMetrics({ compactionCount: 0 })}
      />,
    );

    expect(screen.getByRole('button')).not.toHaveTextContent('compaction');
    unmount();

    // With compactions — should show
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

    // totalContext(100k) / fallbackWindow(200k) = 50%
    expect(screen.getByRole('button')).toHaveTextContent('50%');
  });

  it('should load visibility preferences from localStorage on mount', () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        tokens: false,
        cost: true,
        context: false,
        compactions: false,
      }),
    );

    render(
      <InlineSessionSummaryChip {...defaultProps} metrics={makeMetrics({ compactionCount: 3 })} />,
    );

    const chip = screen.getByRole('button');
    expect(chip).not.toHaveTextContent('2.4k');
    expect(chip).toHaveTextContent('$0.04');
    expect(chip).not.toHaveTextContent('50%');
    expect(chip).not.toHaveTextContent('compaction');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('should fallback to defaults when stored JSON is invalid', () => {
    window.localStorage.setItem(storageKey, '{invalid-json');
    render(
      <InlineSessionSummaryChip {...defaultProps} metrics={makeMetrics({ compactionCount: 2 })} />,
    );

    const chip = screen.getByRole('button');
    expect(chip).toHaveTextContent('2.4k');
    expect(chip).toHaveTextContent('$0.04');
    expect(chip).toHaveTextContent('50%');
    expect(chip).toHaveTextContent('2 compactions');
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('should keep model and status dot visible when all metric items are disabled', () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        tokens: false,
        cost: false,
        context: false,
        compactions: false,
      }),
    );

    render(
      <InlineSessionSummaryChip
        {...defaultProps}
        metrics={makeMetrics({ compactionCount: 4, isOngoing: true })}
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

  it('should persist visibility toggles to localStorage', async () => {
    render(
      <InlineSessionSummaryChip {...defaultProps} metrics={makeMetrics({ compactionCount: 2 })} />,
    );

    const chip = screen.getByRole('button');
    await openVisibilityMenu(chip);

    fireEvent.click(screen.getByText('Tokens'));
    expect(chip).not.toHaveTextContent('2.4k');
    expect(window.localStorage.getItem(storageKey)).toContain('"tokens":false');
  });

  it('should toggle cost, context, and compactions visibility via context menu', async () => {
    render(
      <InlineSessionSummaryChip {...defaultProps} metrics={makeMetrics({ compactionCount: 2 })} />,
    );

    const chip = screen.getByRole('button');
    await openVisibilityMenu(chip);
    fireEvent.click(screen.getByText('Cost'));
    expect(chip).not.toHaveTextContent('$0.04');

    await openVisibilityMenu(chip);
    fireEvent.click(screen.getByText('Context'));
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(chip).not.toHaveTextContent('50%');

    await openVisibilityMenu(chip);
    fireEvent.click(screen.getByText('Compactions'));
    expect(chip).not.toHaveTextContent('2 compactions');
  });

  it('should open context menu via Shift+F10 keyboard shortcut', async () => {
    render(<InlineSessionSummaryChip {...defaultProps} />);

    const chip = screen.getByRole('button');
    expect(chip).toHaveAttribute('aria-haspopup', 'menu');
    expect(chip).toHaveAttribute('aria-expanded', 'false');

    fireEvent.keyDown(chip, { key: 'F10', shiftKey: true });

    await waitFor(() => {
      expect(screen.getByText('Visible Items')).toBeInTheDocument();
      expect(chip).toHaveAttribute('aria-expanded', 'true');
    });
  });

  it('should update aria-expanded when context menu opens and closes', async () => {
    render(<InlineSessionSummaryChip {...defaultProps} />);
    const chip = screen.getByRole('button');

    expect(chip).toHaveAttribute('aria-expanded', 'false');
    await openVisibilityMenu(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(chip).toHaveAttribute('aria-expanded', 'false');
    });
  });

  it('should keep aria-label comprehensive even when metrics are hidden by prefs', async () => {
    render(<InlineSessionSummaryChip {...defaultProps} />);
    const chip = screen.getByRole('button');

    await openVisibilityMenu(chip);
    fireEvent.click(screen.getByText('Tokens'));
    await openVisibilityMenu(chip);
    fireEvent.click(screen.getByText('Cost'));
    await openVisibilityMenu(chip);
    fireEvent.click(screen.getByText('Context'));

    expect(chip).toHaveAttribute('aria-label', expect.stringContaining('total 2.4k tokens'));
    expect(chip).toHaveAttribute('aria-label', expect.stringContaining('cost $0.04'));
    expect(chip).toHaveAttribute('aria-label', expect.stringContaining('context window 50% used'));
    expect(chip).toHaveAttribute('aria-label', expect.stringContaining('compactions 0'));
  });

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

  it('should show tooltip on hover when context menu is closed', async () => {
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

  it('should suppress tooltip while context menu is open', async () => {
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

      await openVisibilityMenu(chip);
      expect(screen.queryAllByText('Session Metrics')).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
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
          />,
        ),
      ).not.toThrow();
    } finally {
      consoleErrorSpy.mockRestore();
      (globalThis as unknown as { window?: Window }).window = originalWindow;
    }
  });
});
