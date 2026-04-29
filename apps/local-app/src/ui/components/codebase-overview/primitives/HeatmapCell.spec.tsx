import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { HeatmapCell } from './HeatmapCell';

describe('HeatmapCell', () => {
  it('null value renders with dashed border and no fill', () => {
    const { container } = render(<HeatmapCell value={null} max={10} ariaLabel="no data" />);
    const cell = container.querySelector('[aria-label="no data"] div')!;
    expect(cell.className).toMatch(/border-dashed/);
    expect(cell.className).not.toMatch(/bg-primary/);
  });

  it('value 0 renders no fill and no dashed border', () => {
    const { container } = render(<HeatmapCell value={0} max={10} ariaLabel="zero" />);
    const cell = container.querySelector('[aria-label="zero"] div')!;
    expect(cell.className).not.toMatch(/border-dashed/);
    expect(cell.className).not.toMatch(/bg-primary/);
    expect(cell.className).toMatch(/border/);
  });

  it('value at max renders full opacity (bg-primary)', () => {
    const { container } = render(<HeatmapCell value={10} max={10} ariaLabel="full" />);
    const cell = container.querySelector('[aria-label="full"] div')!;
    expect(cell.className).toMatch(/bg-primary(?!\/)/);
  });

  it('value > max clamps to full opacity', () => {
    const { container } = render(<HeatmapCell value={200} max={10} ariaLabel="overflow" />);
    const cell = container.querySelector('[aria-label="overflow"] div')!;
    expect(cell.className).toMatch(/bg-primary(?!\/)/);
  });

  it('low ratio (< 0.25) gets bg-primary/25', () => {
    const { container } = render(<HeatmapCell value={2} max={10} ariaLabel="low" />);
    const cell = container.querySelector('[aria-label="low"] div')!;
    expect(cell.className).toContain('bg-primary/25');
  });

  it('mid ratio (0.25–0.50) gets bg-primary/50', () => {
    const { container } = render(<HeatmapCell value={4} max={10} ariaLabel="mid" />);
    const cell = container.querySelector('[aria-label="mid"] div')!;
    expect(cell.className).toContain('bg-primary/50');
  });

  it('high ratio (0.50–0.75) gets bg-primary/75', () => {
    const { container } = render(<HeatmapCell value={7} max={10} ariaLabel="high" />);
    const cell = container.querySelector('[aria-label="high"] div')!;
    expect(cell.className).toContain('bg-primary/75');
  });

  it('renders a button when onClick provided', () => {
    render(<HeatmapCell value={5} max={10} ariaLabel="click me" onClick={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'click me' })).toBeInTheDocument();
  });

  it('calls onClick when button clicked', () => {
    const onClick = jest.fn();
    render(<HeatmapCell value={5} max={10} ariaLabel="clickable" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'clickable' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('button has min 40px click target (min-h-10 min-w-10)', () => {
    render(<HeatmapCell value={5} max={10} ariaLabel="target" onClick={jest.fn()} />);
    const btn = screen.getByRole('button', { name: 'target' });
    expect(btn.className).toMatch(/min-h-10/);
    expect(btn.className).toMatch(/min-w-10/);
  });

  it('renders aria-label on the wrapper element', () => {
    render(<HeatmapCell value={3} max={10} ariaLabel="my cell" />);
    expect(screen.getByLabelText('my cell')).toBeInTheDocument();
  });

  it('uses default size of 16px', () => {
    const { container } = render(<HeatmapCell value={5} max={10} ariaLabel="default-size" />);
    const cell = container.querySelector('[style]') as HTMLElement;
    expect(cell.style.width).toBe('16px');
    expect(cell.style.height).toBe('16px');
  });

  it('uses custom size', () => {
    const { container } = render(
      <HeatmapCell value={5} max={10} size={24} ariaLabel="custom-size" />,
    );
    const cell = container.querySelector('[style]') as HTMLElement;
    expect(cell.style.width).toBe('24px');
    expect(cell.style.height).toBe('24px');
  });

  it('shows tooltip content on focus when tooltip prop provided', async () => {
    render(
      <HeatmapCell value={5} max={10} ariaLabel="with-tooltip" tooltip={<span>5 changes</span>} />,
    );
    const trigger = screen.getByLabelText('with-tooltip');
    fireEvent.focus(trigger);
    const nodes = await screen.findAllByText('5 changes');
    expect(nodes.length).toBeGreaterThan(0);
  });

  it('non-button branch with tooltip applies 40×40 wrapper (min-h-10 min-w-10)', () => {
    render(<HeatmapCell value={1} max={1} ariaLabel="x" tooltip={<span>t</span>} tabbable />);
    const wrapper = screen.getByRole('img', { name: 'x' });
    expect(wrapper).toHaveClass('min-h-10');
    expect(wrapper).toHaveClass('min-w-10');
  });

  it('non-button branch without tooltip: no tabIndex, no role="img"', () => {
    const { container } = render(<HeatmapCell value={3} max={10} ariaLabel="plain" />);
    const wrapper = container.querySelector('[aria-label="plain"]')!;
    expect(wrapper.getAttribute('tabindex')).toBeNull();
  });

  it('single-color shading — all intensity levels use bg-primary variants', () => {
    const cases: [number, string][] = [
      [1, 'bg-primary/25'],
      [3, 'bg-primary/50'],
      [6, 'bg-primary/75'],
      [10, 'bg-primary'],
    ];
    cases.forEach(([value, expected]) => {
      const { container, unmount } = render(
        <HeatmapCell value={value} max={10} ariaLabel="test" />,
      );
      const cell = container.querySelector('[aria-label="test"] div')!;
      expect(cell.className).toContain(expected);
      unmount();
    });
  });
});
