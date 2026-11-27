import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThinkingBlock } from './ThinkingBlock';
import type { SerializedSemanticStep } from '@/ui/hooks/useSessionTranscript';
import { renderWithMode } from './__tests__/test-utils';
import { installLayoutMock, type LayoutMock } from './__tests__/layout-mock';
import { TranscriptDisclosureProvider } from '@/ui/hooks/useTranscriptDisclosure';

const toggle = () => screen.queryByRole('button', { name: /^show (full|less)$/i });

function makeStep(overrides: Partial<SerializedSemanticStep> = {}): SerializedSemanticStep {
  return {
    id: 'step-1',
    type: 'thinking',
    startTime: '2026-02-24T12:00:00.000Z',
    durationMs: 2500,
    estimatedTokens: 1300,
    content: {
      thinkingText: 'Let me analyze this problem step by step.',
    },
    tokens: { input: 500, output: 800 },
    context: 'main',
    ...overrides,
  };
}

describe('ThinkingBlock', () => {
  it('shows token count badge when estimatedTokens is available', () => {
    render(<ThinkingBlock step={makeStep({ estimatedTokens: 1300 })} />);
    const badge = screen.getByTestId('thinking-token-badge');
    expect(badge).toHaveTextContent('~1.3k');
  });

  it('hides token badge when estimatedTokens is missing', () => {
    render(<ThinkingBlock step={makeStep({ estimatedTokens: undefined })} />);
    expect(screen.queryByTestId('thinking-token-badge')).not.toBeInTheDocument();
  });

  it('shows duration in trigger', () => {
    render(<ThinkingBlock step={makeStep({ durationMs: 2500 })} />);
    expect(screen.getByTestId('thinking-duration')).toHaveTextContent('2.5s');
  });

  it('shows thinking preview text in trigger', () => {
    render(<ThinkingBlock step={makeStep()} />);
    expect(screen.getByTestId('thinking-preview')).toHaveTextContent(
      '— Let me analyze this problem step by step.',
    );
  });

  it('truncates preview text to around 80 chars with ellipsis', () => {
    const longThinking = 'A'.repeat(120);
    render(<ThinkingBlock step={makeStep({ content: { thinkingText: longThinking } })} />);
    expect(screen.getByTestId('thinking-preview')).toHaveTextContent(`— ${'A'.repeat(80)}…`);
  });

  it('hides preview when thinking text is empty', () => {
    render(<ThinkingBlock step={makeStep({ content: { thinkingText: '' } })} />);
    expect(screen.queryByTestId('thinking-preview')).not.toBeInTheDocument();
  });

  it('uses estimatedTokens instead of message token aggregate', () => {
    render(
      <ThinkingBlock
        step={makeStep({
          estimatedTokens: 0,
          tokens: { input: 5000, output: 5000 },
        })}
      />,
    );
    expect(screen.queryByTestId('thinking-token-badge')).not.toBeInTheDocument();
  });

  it('expands to show thinking content on click', () => {
    render(<ThinkingBlock step={makeStep()} />);

    // Content hidden initially
    expect(screen.queryByTestId('thinking-block-content')).not.toBeInTheDocument();

    // Click to expand
    expect(screen.getByTestId('thinking-block-trigger')).toHaveAttribute('data-state', 'closed');
    fireEvent.click(screen.getByTestId('thinking-block-trigger'));
    expect(screen.getByTestId('thinking-block-trigger')).toHaveAttribute('data-state', 'open');
    expect(screen.getByTestId('thinking-block-content')).toBeInTheDocument();
    expect(screen.getByText('Let me analyze this problem step by step.')).toBeInTheDocument();
  });

  describe('preview box', () => {
    let layout: LayoutMock;
    beforeEach(() => {
      layout = installLayoutMock();
    });
    afterEach(() => layout.restore());

    it('one "Show full" reveals both the character cap and the height clip', () => {
      const longText = 'A'.repeat(6000);
      render(<ThinkingBlock step={makeStep({ content: { thinkingText: longText } })} />);
      fireEvent.click(screen.getByTestId('thinking-block-trigger'));

      const content = screen.getByTestId('thinking-block-content');
      expect(content.textContent).toBe('A'.repeat(5000) + '…');
      expect(content.parentElement?.parentElement?.style.maxHeight).toBe('256px');
      expect(screen.getAllByRole('button', { name: /^show/i })).toHaveLength(1);

      fireEvent.click(screen.getByRole('button', { name: 'Show full' }));

      expect(content.textContent).toBe(longText);
      expect(content.parentElement?.parentElement?.style.maxHeight).toBe('');
      expect(toggle()).toHaveTextContent('Show less');
    });

    it('shows the toggle for text under the character cap that overflows the height', () => {
      render(<ThinkingBlock step={makeStep({ content: { thinkingText: 'B'.repeat(1000) } })} />);
      fireEvent.click(screen.getByTestId('thinking-block-trigger'));
      expect(toggle()).toHaveTextContent('Show full');
    });

    it('shows no toggle for short text', () => {
      render(<ThinkingBlock step={makeStep()} />);
      fireEvent.click(screen.getByTestId('thinking-block-trigger'));
      expect(toggle()).toBeNull();
    });

    it.each([
      { length: 5000, cut: false },
      { length: 5001, cut: true },
    ])('character cap boundary: $length chars → cut $cut', ({ length, cut }) => {
      const text = 'C'.repeat(length);
      render(<ThinkingBlock step={makeStep({ content: { thinkingText: text } })} />);
      fireEvent.click(screen.getByTestId('thinking-block-trigger'));
      expect(screen.getByTestId('thinking-block-content').textContent).toBe(
        cut ? 'C'.repeat(5000) + '…' : text,
      );
    });

    it('keeps the section and the expanded text open across a remount', () => {
      const step = makeStep({ content: { thinkingText: 'E'.repeat(6000) } });
      const ui = (children: React.ReactNode) => (
        <TranscriptDisclosureProvider scope="s">{children}</TranscriptDisclosureProvider>
      );
      const { rerender } = render(ui(<ThinkingBlock chunkId="chunk-1" step={step} />));
      fireEvent.click(screen.getByTestId('thinking-block-trigger'));
      fireEvent.click(screen.getByRole('button', { name: 'Show full' }));

      rerender(ui(null));
      rerender(ui(<ThinkingBlock chunkId="chunk-1" step={step} />));

      expect(screen.getByTestId('thinking-block-trigger')).toHaveAttribute('data-state', 'open');
      expect(screen.getByTestId('thinking-block-content').textContent).toBe('E'.repeat(6000));
    });
  });

  // ---------------------------------------------------------------------------
  // Step-level hotspot visual treatment
  // ---------------------------------------------------------------------------

  it('shows warning border, flame icon, and percentage when isStepHot=true (diagnostic mode)', () => {
    renderWithMode(<ThinkingBlock step={makeStep()} isStepHot percentOfChunk={45} />, 'diagnostic');

    const wrapper = screen.getByTestId('thinking-block-wrapper');
    expect(wrapper).toHaveClass('border-status-warn');
    expect(wrapper.className).toContain('border-l-2');

    expect(screen.getByTestId('step-hotspot-flame')).toBeInTheDocument();

    const pct = screen.getByTestId('step-hotspot-pct');
    expect(pct).toHaveTextContent('45%');
  });

  it('hides hotspot indicators in Reader mode even when isStepHot=true', () => {
    render(<ThinkingBlock step={makeStep()} isStepHot percentOfChunk={45} />);

    expect(screen.queryByTestId('step-hotspot-flame')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-hotspot-pct')).not.toBeInTheDocument();
  });

  it('does not show hotspot indicators when isStepHot is false or undefined', () => {
    render(<ThinkingBlock step={makeStep()} />);

    const wrapper = screen.getByTestId('thinking-block-wrapper');
    expect(wrapper.className).not.toMatch(/border-status-warn/);

    expect(screen.queryByTestId('step-hotspot-flame')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-hotspot-pct')).not.toBeInTheDocument();
  });

  it('does not show percentage badge when percentOfChunk is 0 (diagnostic mode)', () => {
    renderWithMode(<ThinkingBlock step={makeStep()} isStepHot percentOfChunk={0} />, 'diagnostic');

    expect(screen.getByTestId('step-hotspot-flame')).toBeInTheDocument();
    expect(screen.queryByTestId('step-hotspot-pct')).not.toBeInTheDocument();
  });
});
