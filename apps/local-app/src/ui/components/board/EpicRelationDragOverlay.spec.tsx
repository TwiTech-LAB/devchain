import { createRef } from 'react';
import { act, render, screen } from '@testing-library/react';
import {
  EpicRelationDragOverlay,
  type EpicRelationDragOverlayHandle,
} from '@/ui/components/board/EpicRelationDragOverlay';

describe('EpicRelationDragOverlay', () => {
  it('renders a fixed portal line and hides synchronously through its isolated handle', () => {
    const ref = createRef<EpicRelationDragOverlayHandle>();
    render(<EpicRelationDragOverlay ref={ref} />);

    act(() => ref.current?.show({ x: 10, y: 20 }, { x: 30, y: 40 }));
    const overlay = screen.getByTestId('epic-relation-drag-overlay');
    expect(overlay).toHaveClass('fixed', 'overflow-visible');
    expect(overlay.parentElement).toBe(document.body);
    expect(overlay.querySelector('line')).toHaveAttribute('x1', '10');
    expect(overlay.querySelector('line')).toHaveAttribute('y1', '20');
    expect(overlay.querySelector('line')).toHaveAttribute('x2', '30');
    expect(overlay.querySelector('line')).toHaveAttribute('y2', '40');

    act(() => ref.current?.hide());
    expect(screen.queryByTestId('epic-relation-drag-overlay')).not.toBeInTheDocument();
  });

  it('coalesces pointer updates into one animation frame owned by the overlay', () => {
    const callbacks: FrameRequestCallback[] = [];
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const ref = createRef<EpicRelationDragOverlayHandle>();
    render(<EpicRelationDragOverlay ref={ref} />);

    act(() => {
      ref.current?.show({ x: 0, y: 0 }, { x: 1, y: 1 });
      ref.current?.update({ x: 2, y: 2 });
      ref.current?.update({ x: 9, y: 8 });
    });
    expect(callbacks).toHaveLength(1);

    act(() => callbacks[0](16));
    const line = screen.getByTestId('epic-relation-drag-overlay').querySelector('line');
    expect(line).toHaveAttribute('x2', '9');
    expect(line).toHaveAttribute('y2', '8');
  });
});
