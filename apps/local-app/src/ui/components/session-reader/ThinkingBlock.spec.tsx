import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThinkingBlock } from './ThinkingBlock';
import type { SerializedSemanticStep } from '@/ui/hooks/useSessionTranscript';

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
  it('renders collapsed trigger with Thinking label', () => {
    render(<ThinkingBlock step={makeStep()} />);
    expect(screen.getByTestId('thinking-block-trigger')).toBeInTheDocument();
    expect(screen.getByText('Thinking')).toBeInTheDocument();
  });

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
    fireEvent.click(screen.getByTestId('thinking-block-trigger'));
    expect(screen.getByTestId('thinking-block-content')).toBeInTheDocument();
    expect(screen.getByText('Let me analyze this problem step by step.')).toBeInTheDocument();
  });

  it('truncates long thinking text with show more button', () => {
    const longText = 'A'.repeat(6000);
    render(<ThinkingBlock step={makeStep({ content: { thinkingText: longText } })} />);

    // Expand to see content
    fireEvent.click(screen.getByTestId('thinking-block-trigger'));

    // Should be truncated
    const content = screen.getByTestId('thinking-block-content');
    expect(content.textContent!.length).toBeLessThan(longText.length);

    // Show more button should be visible
    const showMore = screen.getByTestId('thinking-show-more');
    expect(showMore).toHaveTextContent('Show more');

    // Click to expand
    fireEvent.click(showMore);
    expect(content.textContent).toBe(longText);
    expect(showMore).toHaveTextContent('Show less');
  });

  it('does not show show-more for short text', () => {
    render(<ThinkingBlock step={makeStep()} />);
    fireEvent.click(screen.getByTestId('thinking-block-trigger'));
    expect(screen.queryByTestId('thinking-show-more')).not.toBeInTheDocument();
  });

  it('does not truncate text at old 3000-char threshold', () => {
    const text3k = 'B'.repeat(3000);
    render(<ThinkingBlock step={makeStep({ content: { thinkingText: text3k } })} />);
    fireEvent.click(screen.getByTestId('thinking-block-trigger'));

    const content = screen.getByTestId('thinking-block-content');
    expect(content.textContent).toBe(text3k);
    expect(screen.queryByTestId('thinking-show-more')).not.toBeInTheDocument();
  });

  it('does not truncate text at exactly 5000 chars (boundary)', () => {
    const text5k = 'C'.repeat(5000);
    render(<ThinkingBlock step={makeStep({ content: { thinkingText: text5k } })} />);
    fireEvent.click(screen.getByTestId('thinking-block-trigger'));

    const content = screen.getByTestId('thinking-block-content');
    expect(content.textContent).toBe(text5k);
    expect(screen.queryByTestId('thinking-show-more')).not.toBeInTheDocument();
  });

  it('truncates text at 5001 chars (just above threshold)', () => {
    const text5001 = 'D'.repeat(5001);
    render(<ThinkingBlock step={makeStep({ content: { thinkingText: text5001 } })} />);
    fireEvent.click(screen.getByTestId('thinking-block-trigger'));

    const content = screen.getByTestId('thinking-block-content');
    // Truncated: first 5000 chars + ellipsis — content differs from original
    expect(content.textContent).not.toBe(text5001);
    expect(content.textContent!.endsWith('…')).toBe(true);
    expect(screen.getByTestId('thinking-show-more')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Step-level hotspot visual treatment
  // ---------------------------------------------------------------------------

  it('shows amber border, flame icon, and percentage when isStepHot=true', () => {
    render(<ThinkingBlock step={makeStep()} isStepHot percentOfChunk={45} />);

    const wrapper = screen.getByTestId('thinking-block-wrapper');
    expect(wrapper.className).toContain('border-amber-500');
    expect(wrapper.className).toContain('border-l-2');

    expect(screen.getByTestId('step-hotspot-flame')).toBeInTheDocument();

    const pct = screen.getByTestId('step-hotspot-pct');
    expect(pct).toHaveTextContent('45%');
  });

  it('does not show hotspot indicators when isStepHot is false or undefined', () => {
    render(<ThinkingBlock step={makeStep()} />);

    const wrapper = screen.getByTestId('thinking-block-wrapper');
    expect(wrapper.className).not.toContain('border-amber-500');

    expect(screen.queryByTestId('step-hotspot-flame')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-hotspot-pct')).not.toBeInTheDocument();
  });

  it('does not show percentage badge when percentOfChunk is 0', () => {
    render(<ThinkingBlock step={makeStep()} isStepHot percentOfChunk={0} />);

    expect(screen.getByTestId('step-hotspot-flame')).toBeInTheDocument();
    expect(screen.queryByTestId('step-hotspot-pct')).not.toBeInTheDocument();
  });
});
