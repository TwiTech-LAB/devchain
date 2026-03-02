import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useAutoScrollBottom } from './useAutoScrollBottom';

// ---------------------------------------------------------------------------
// Test harness component
// ---------------------------------------------------------------------------

function TestComponent({ enabled, triggerDep }: { enabled: boolean; triggerDep: unknown }) {
  const { scrollContainerRef, bottomRef, isAtBottom, scrollToBottom, handleScroll } =
    useAutoScrollBottom({ enabled, triggerDep });

  return (
    <div>
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        data-testid="scroll-container"
        style={{ height: 100, overflow: 'auto' }}
      >
        <div style={{ height: 500 }}>content</div>
        <div ref={bottomRef} data-testid="bottom-sentinel" />
      </div>
      <span data-testid="at-bottom">{String(isAtBottom)}</span>
      <button data-testid="scroll-btn" onClick={scrollToBottom}>
        Scroll
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAutoScrollBottom', () => {
  // jsdom doesn't implement scrollIntoView, so we mock it
  const scrollIntoViewMock = jest.fn();

  beforeEach(() => {
    scrollIntoViewMock.mockClear();
    Element.prototype.scrollIntoView = scrollIntoViewMock;
  });

  afterEach(() => {
    // @ts-expect-error restoring original
    delete Element.prototype.scrollIntoView;
  });

  it('initializes with isAtBottom true', () => {
    render(<TestComponent enabled={false} triggerDep={0} />);
    expect(screen.getByTestId('at-bottom').textContent).toBe('true');
  });

  it('provides scrollContainerRef and bottomRef', () => {
    render(<TestComponent enabled={false} triggerDep={0} />);
    expect(screen.getByTestId('scroll-container')).toBeInTheDocument();
    expect(screen.getByTestId('bottom-sentinel')).toBeInTheDocument();
  });

  it('calls scrollIntoView on triggerDep change when enabled and at bottom', () => {
    const { rerender } = render(<TestComponent enabled={true} triggerDep={0} />);

    // Initial render triggers effect
    const initialCalls = scrollIntoViewMock.mock.calls.length;

    // Change triggerDep
    rerender(<TestComponent enabled={true} triggerDep={1} />);
    expect(scrollIntoViewMock.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it('does not auto-scroll when disabled', () => {
    const { rerender } = render(<TestComponent enabled={false} triggerDep={0} />);
    scrollIntoViewMock.mockClear();

    rerender(<TestComponent enabled={false} triggerDep={1} />);
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it('scrollToBottom calls scrollIntoView', () => {
    render(<TestComponent enabled={false} triggerDep={0} />);
    scrollIntoViewMock.mockClear();

    fireEvent.click(screen.getByTestId('scroll-btn'));
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'smooth' });
  });

  it('updates isAtBottom on scroll', () => {
    render(<TestComponent enabled={false} triggerDep={0} />);

    const container = screen.getByTestId('scroll-container');

    // Simulate scroll up — jsdom doesn't have real scrollHeight/clientHeight,
    // but we can trigger the handler and verify state updates
    act(() => {
      // Set scroll properties to simulate "scrolled up"
      Object.defineProperty(container, 'scrollHeight', { value: 500, configurable: true });
      Object.defineProperty(container, 'scrollTop', { value: 0, configurable: true });
      Object.defineProperty(container, 'clientHeight', { value: 100, configurable: true });
      fireEvent.scroll(container);
    });

    expect(screen.getByTestId('at-bottom').textContent).toBe('false');
  });

  it('detects at bottom when scrolled near bottom', () => {
    render(<TestComponent enabled={false} triggerDep={0} />);

    const container = screen.getByTestId('scroll-container');

    act(() => {
      // scrollHeight - scrollTop - clientHeight = 500 - 380 - 100 = 20 < 48 → at bottom
      Object.defineProperty(container, 'scrollHeight', { value: 500, configurable: true });
      Object.defineProperty(container, 'scrollTop', { value: 380, configurable: true });
      Object.defineProperty(container, 'clientHeight', { value: 100, configurable: true });
      fireEvent.scroll(container);
    });

    expect(screen.getByTestId('at-bottom').textContent).toBe('true');
  });
});
