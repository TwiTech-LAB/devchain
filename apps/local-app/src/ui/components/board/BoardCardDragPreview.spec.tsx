import { createRef } from 'react';
import { act, render, screen } from '@testing-library/react';
import {
  BoardCardDragPreview,
  type BoardCardDragPreviewHandle,
} from '@/ui/components/board/BoardCardDragPreview';

// Component unit tests inspect the real DOM clone and frame scheduling with a supplied source rect.
describe('BoardCardDragPreview', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('clones the complete source without IDs, preserves width and offset, and coalesces movement', () => {
    const ref = createRef<BoardCardDragPreviewHandle>();
    render(<BoardCardDragPreview ref={ref} />);
    const source = document.createElement('div');
    source.id = 'card';
    source.innerHTML = '<div id="title">Card</div><footer id="footer">Open linked task</footer>';
    source.getBoundingClientRect = jest.fn(() => ({ left: 10, top: 20, width: 200 }) as DOMRect);
    act(() => ref.current!.show(source, { x: 30, y: 40 }, { x: 60, y: 80 }));
    const preview = screen.getByTestId('board-card-drag-preview');
    expect(preview.parentElement).toBe(document.body);
    expect(preview).toHaveAttribute('aria-hidden', 'true');
    expect(preview).toHaveClass('fixed', 'pointer-events-none');
    expect(preview.querySelectorAll('[id]')).toHaveLength(0);
    expect(preview).toHaveTextContent('Open linked task');
    expect(source.querySelectorAll('[id]')).toHaveLength(2);
    expect(preview).toHaveStyle({ width: '200px', transform: 'translate3d(40px, 60px, 0)' });
    act(() => {
      ref.current!.update({ x: 90, y: 100 });
      ref.current!.update({ x: 110, y: 120 });
    });
    expect(preview.style.transform).toBe('translate3d(40px, 60px, 0)');
    act(() => jest.advanceTimersByTime(16));
    expect(preview.style.transform).toBe('translate3d(90px, 100px, 0)');
    act(() => {
      ref.current!.update({ x: 500, y: 500 });
      ref.current!.hide();
      jest.runOnlyPendingTimers();
    });
    expect(preview).toHaveStyle({ display: 'none' });
    expect(preview.childElementCount).toBe(0);
  });
});
