import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AgentContextBar } from './AgentContextBar';

// Polyfill DOMRect for floating-ui (Radix Tooltip positioning)
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

describe('AgentContextBar', () => {
  it('renders null when contextPercent is 0', () => {
    const { container } = render(
      <AgentContextBar contextPercent={0} totalContextTokens={0} contextWindowTokens={200_000} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders null when contextWindowTokens is 0', () => {
    const { container } = render(
      <AgentContextBar contextPercent={50} totalContextTokens={100_000} contextWindowTokens={0} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('no spacer div rendered when bar is effectively hidden (no row-height drift)', () => {
    const { container } = render(
      <AgentContextBar contextPercent={0} totalContextTokens={0} contextWindowTokens={0} />,
    );
    expect(container.firstChild).toBeNull();
    expect(container.childElementCount).toBe(0);
  });

  it('renders bar with bg-primary/60 for contextPercent < 50', () => {
    render(
      <AgentContextBar
        contextPercent={30}
        totalContextTokens={60_000}
        contextWindowTokens={200_000}
      />,
    );
    const progressbar = screen.getByRole('progressbar');
    const fill = progressbar.firstElementChild as HTMLElement;
    expect(fill.className).toContain('bg-primary/60');
    expect(fill.className).not.toContain('bg-amber-500');
    expect(fill.className).not.toContain('bg-destructive');
  });

  it('renders bar with bg-amber-500 for contextPercent 50-80', () => {
    render(
      <AgentContextBar
        contextPercent={65}
        totalContextTokens={130_000}
        contextWindowTokens={200_000}
      />,
    );
    const progressbar = screen.getByRole('progressbar');
    const fill = progressbar.firstElementChild as HTMLElement;
    expect(fill.className).toContain('bg-amber-500');
    expect(fill.className).not.toContain('bg-primary/60');
    expect(fill.className).not.toContain('bg-destructive');
  });

  it('renders bar with bg-destructive for contextPercent > 80', () => {
    render(
      <AgentContextBar
        contextPercent={90}
        totalContextTokens={180_000}
        contextWindowTokens={200_000}
      />,
    );
    const progressbar = screen.getByRole('progressbar');
    const fill = progressbar.firstElementChild as HTMLElement;
    expect(fill.className).toContain('bg-destructive');
    expect(fill.className).not.toContain('bg-amber-500');
    expect(fill.className).not.toContain('bg-primary/60');
  });

  it('tooltip shows formatted context info', () => {
    jest.useFakeTimers();
    render(
      <AgentContextBar
        contextPercent={50}
        totalContextTokens={100_000}
        contextWindowTokens={200_000}
      />,
    );
    const progressbar = screen.getByRole('progressbar');

    // Trigger tooltip via pointer event
    fireEvent.pointerMove(progressbar);
    act(() => {
      jest.advanceTimersByTime(300); // delayDuration is 200
    });

    // Tooltip content rendered (may appear in both trigger label and tooltip)
    const matches = screen.getAllByText(/Context: 50% used \(100k of 200k\)/);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    jest.useRealTimers();
  });

  it('sets correct aria attributes on progressbar', () => {
    render(
      <AgentContextBar
        contextPercent={50}
        totalContextTokens={100_000}
        contextWindowTokens={200_000}
      />,
    );
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toHaveAttribute('aria-valuenow', '50');
    expect(progressbar).toHaveAttribute('aria-valuemin', '0');
    expect(progressbar).toHaveAttribute('aria-valuemax', '100');
    expect(progressbar).toHaveAttribute('aria-valuetext', 'Context window 50% used');
    expect(progressbar).toHaveAttribute('aria-label', 'Context window usage');
  });

  it('fill width matches contextPercent and handles clamping in hook layer', () => {
    // The hook clamps values to 0-100; the component renders the value it receives
    render(
      <AgentContextBar
        contextPercent={75}
        totalContextTokens={150_000}
        contextWindowTokens={200_000}
      />,
    );
    const progressbar = screen.getByRole('progressbar');
    const fill = progressbar.firstElementChild as HTMLElement;
    expect(fill.style.width).toBe('75%');
  });
});
