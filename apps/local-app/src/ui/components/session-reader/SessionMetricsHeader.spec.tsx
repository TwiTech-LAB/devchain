import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionMetricsHeader } from './SessionMetricsHeader';
import type { UnifiedMetrics } from '@/modules/session-reader/dtos/unified-session.types';

function makeMetrics(overrides: Partial<UnifiedMetrics> = {}): UnifiedMetrics {
  return {
    inputTokens: 5000,
    outputTokens: 3000,
    cacheReadTokens: 1200,
    cacheCreationTokens: 800,
    totalTokens: 10000,
    totalContextConsumption: 15000,
    compactionCount: 0,
    phaseBreakdowns: [],
    visibleContextTokens: 40000,
    totalContextTokens: 100000,
    contextWindowTokens: 200000,
    costUsd: 0.15,
    primaryModel: 'claude-sonnet-4-6',
    modelsUsed: ['claude-sonnet-4-6'],
    durationMs: 150000,
    messageCount: 24,
    isOngoing: false,
    ...overrides,
  };
}

describe('SessionMetricsHeader', () => {
  it('shows +N models badge when multiple models used', () => {
    render(
      <SessionMetricsHeader
        metrics={makeMetrics({
          modelsUsed: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-6'],
        })}
      />,
    );
    const badge = screen.getByTestId('model-count-badge');
    expect(badge).toHaveTextContent('+2');
  });

  it('shows model, token categories, context and message count without inactive badges', () => {
    render(<SessionMetricsHeader metrics={makeMetrics()} />);
    {
      const tokens = screen.getByTestId('metrics-tokens');
      expect(tokens).toHaveTextContent('In: 5.0k');
      expect(tokens).toHaveTextContent('CR: 1.2k');
      expect(tokens).toHaveTextContent('CW: 800');
      expect(tokens).toHaveTextContent('Out: 3.0k');
    }
    {
      expect(screen.getByTestId('metrics-model')).toHaveTextContent('claude-sonnet-4-6');
    }
    {
      expect(screen.queryByTestId('model-count-badge')).not.toBeInTheDocument();
    }
    {
      const total = screen.getByTestId('metrics-total-tokens');
      expect(total).toHaveTextContent('10k');
      expect(total).toHaveClass('font-semibold');
    }
    {
      const progressBar = screen.getByRole('progressbar');
      expect(progressBar).toHaveAttribute('aria-valuenow', '50');
      expect(progressBar).toHaveAttribute('aria-label', 'Context window 50% used');
    }
    {
      expect(screen.getByTestId('metrics-messages')).toHaveTextContent('24 msgs');
    }
    {
      expect(screen.queryByTestId('metrics-live')).not.toBeInTheDocument();
    }
    {
      expect(screen.queryByTestId('metrics-compactions')).not.toBeInTheDocument();
    }
    {
      expect(screen.queryByTestId('phase-breakdown-trigger')).not.toBeInTheDocument();
    }
  });

  it('shows cost', () => {
    render(<SessionMetricsHeader metrics={makeMetrics({ costUsd: 1.23 })} />);
    expect(screen.getByTestId('metrics-cost')).toHaveTextContent('$1.23');
  });

  it('shows visible context over total context with percentage', () => {
    render(
      <SessionMetricsHeader
        metrics={makeMetrics({
          visibleContextTokens: 40000,
          totalContextTokens: 100000,
          contextWindowTokens: 200000,
        })}
      />,
    );
    expect(screen.getByTestId('metrics-context')).toHaveTextContent('Visible: 40k / 100k (40%)');
  });

  it.each([
    {
      label: 'uses destructive color for context > 80%',
      totalContextTokens: 180000,
      colorClass: 'bg-destructive',
    },
    {
      label: 'uses amber color for context 50-80%',
      totalContextTokens: 120000,
      colorClass: 'bg-status-warn',
    },
    {
      label: 'uses primary color for context < 50%',
      totalContextTokens: 40000,
      colorClass: 'bg-primary/60',
    },
  ] as const)('$label', ({ totalContextTokens, colorClass }) => {
    render(
      <SessionMetricsHeader
        metrics={makeMetrics({
          totalContextTokens: totalContextTokens,
          contextWindowTokens: 200000,
        })}
      />,
    );
    const progressBar = screen.getByRole('progressbar');
    const fill = progressBar.firstChild as HTMLElement;
    expect(fill).toHaveClass(colorClass);
  });

  it('falls back to 200k context window when contextWindowTokens is 0', () => {
    render(
      <SessionMetricsHeader
        metrics={makeMetrics({ totalContextTokens: 100000, contextWindowTokens: 0 })}
      />,
    );
    // window pct uses fallback 200k context window.
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });

  it('shows duration', () => {
    render(<SessionMetricsHeader metrics={makeMetrics({ durationMs: 150000 })} />);
    expect(screen.getByTestId('metrics-duration')).toHaveTextContent('2m 30s');
  });

  it('hides duration when 0', () => {
    render(<SessionMetricsHeader metrics={makeMetrics({ durationMs: 0 })} />);
    expect(screen.queryByTestId('metrics-duration')).not.toBeInTheDocument();
  });

  it('shows live indicator when ongoing', () => {
    render(<SessionMetricsHeader metrics={makeMetrics({ isOngoing: true })} />);
    expect(screen.getByTestId('metrics-live')).toHaveTextContent('Live');
  });

  it('shows compaction count when > 0', () => {
    render(
      <SessionMetricsHeader
        metrics={makeMetrics({
          compactionCount: 3,
          phaseBreakdowns: [
            { phaseNumber: 1, contribution: 5000, peakTokens: 8000, postCompaction: 3000 },
            { phaseNumber: 2, contribution: 4000, peakTokens: 7000, postCompaction: 2500 },
            { phaseNumber: 3, contribution: 3000, peakTokens: 6000 },
          ],
        })}
      />,
    );
    expect(screen.getByTestId('metrics-compactions')).toHaveTextContent('3 compactions');
  });

  it('shows singular "compaction" for count of 1', () => {
    render(
      <SessionMetricsHeader
        metrics={makeMetrics({
          compactionCount: 1,
          phaseBreakdowns: [
            { phaseNumber: 1, contribution: 5000, peakTokens: 8000, postCompaction: 3000 },
          ],
        })}
      />,
    );
    expect(screen.getByTestId('metrics-compactions')).toHaveTextContent('1 compaction');
    // Should not say "compactions" (plural)
    expect(screen.getByTestId('metrics-compactions').textContent).not.toContain('compactions');
  });

  it('expands phase breakdown on click', () => {
    render(
      <SessionMetricsHeader
        metrics={makeMetrics({
          compactionCount: 2,
          phaseBreakdowns: [
            {
              phaseNumber: 1,
              contribution: 5000,
              peakTokens: 80000,
              postCompaction: 30000,
              compactionMessageId: 'msg-1',
            },
            { phaseNumber: 2, contribution: 4000, peakTokens: 70000 },
          ],
        })}
      />,
    );

    // Phase breakdown hidden initially
    expect(screen.queryByTestId('phase-breakdown-content')).not.toBeInTheDocument();

    // Click to expand
    fireEvent.click(screen.getByTestId('phase-breakdown-trigger'));
    expect(screen.getByTestId('phase-breakdown-content')).toBeInTheDocument();
    expect(screen.getByTestId('phase-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('phase-row-2')).toBeInTheDocument();
  });

  it('shows phase details with contribution, peak, and post-compaction', () => {
    render(
      <SessionMetricsHeader
        metrics={makeMetrics({
          compactionCount: 1,
          phaseBreakdowns: [
            { phaseNumber: 1, contribution: 5000, peakTokens: 80000, postCompaction: 30000 },
          ],
        })}
      />,
    );

    fireEvent.click(screen.getByTestId('phase-breakdown-trigger'));
    const row = screen.getByTestId('phase-row-1');
    expect(row).toHaveTextContent('Phase 1');
    expect(row).toHaveTextContent('5.0k');
    expect(row).toHaveTextContent('Peak:');
    expect(row).toHaveTextContent('80k');
    expect(row).toHaveTextContent('Post:');
    expect(row).toHaveTextContent('30k');
  });

  it('hides post-compaction when not available (active phase)', () => {
    render(
      <SessionMetricsHeader
        metrics={makeMetrics({
          compactionCount: 1,
          phaseBreakdowns: [{ phaseNumber: 2, contribution: 4000, peakTokens: 70000 }],
        })}
      />,
    );

    fireEvent.click(screen.getByTestId('phase-breakdown-trigger'));
    const row = screen.getByTestId('phase-row-2');
    expect(row).toHaveTextContent('Phase 2');
    expect(row).not.toHaveTextContent('Post:');
  });

  it('shows View link for phases with compactionMessageId', () => {
    const onScroll = jest.fn();
    render(
      <SessionMetricsHeader
        metrics={makeMetrics({
          compactionCount: 1,
          phaseBreakdowns: [
            {
              phaseNumber: 1,
              contribution: 5000,
              peakTokens: 80000,
              postCompaction: 30000,
              compactionMessageId: 'msg-compact-1',
            },
          ],
        })}
        onScrollToMessage={onScroll}
      />,
    );

    fireEvent.click(screen.getByTestId('phase-breakdown-trigger'));
    const link = screen.getByTestId('phase-link-1');
    expect(link).toHaveTextContent('View');

    fireEvent.click(link);
    expect(onScroll).toHaveBeenCalledWith('msg-compact-1');
  });

  it('hides View link when no onScrollToMessage callback', () => {
    render(
      <SessionMetricsHeader
        metrics={makeMetrics({
          compactionCount: 1,
          phaseBreakdowns: [
            {
              phaseNumber: 1,
              contribution: 5000,
              peakTokens: 80000,
              postCompaction: 30000,
              compactionMessageId: 'msg-compact-1',
            },
          ],
        })}
      />,
    );

    fireEvent.click(screen.getByTestId('phase-breakdown-trigger'));
    expect(screen.queryByTestId('phase-link-1')).not.toBeInTheDocument();
  });

  it('uses 1M context window for percentage calculation when contextWindowTokens is 1000000', () => {
    render(
      <SessionMetricsHeader
        metrics={makeMetrics({
          totalContextTokens: 100_000,
          contextWindowTokens: 1_000_000,
        })}
      />,
    );

    const progressBar = screen.getByRole('progressbar');
    // 100k / 1M = 10%
    expect(progressBar).toHaveAttribute('aria-label', 'Context window 10% used');
    expect(progressBar).toHaveAttribute('aria-valuenow', '10');
  });
});
