import React from 'react';
import { render, screen } from '@testing-library/react';
import { BarFill } from './BarFill';

describe('BarFill', () => {
  it('renders with correct width percentage', () => {
    const { container } = render(<BarFill value={50} max={100} />);
    const fill = container.querySelector('[style]') as HTMLElement;
    expect(fill.style.width).toBe('50%');
  });

  it('clamps to 100% when value exceeds max', () => {
    const { container } = render(<BarFill value={150} max={100} />);
    const fill = container.querySelector('[style]') as HTMLElement;
    expect(fill.style.width).toBe('100%');
  });

  it('clamps to 0% when value is negative', () => {
    const { container } = render(<BarFill value={-10} max={100} />);
    const fill = container.querySelector('[style]') as HTMLElement;
    expect(fill.style.width).toBe('0%');
  });

  it('renders 0% width when value is null', () => {
    const { container } = render(<BarFill value={null} max={100} />);
    const fill = container.querySelector('[style]') as HTMLElement;
    expect(fill.style.width).toBe('0%');
  });

  it('renders 0% width when value is undefined', () => {
    const { container } = render(<BarFill value={undefined} max={100} />);
    const fill = container.querySelector('[style]') as HTMLElement;
    expect(fill.style.width).toBe('0%');
  });

  it('has accessible meter attributes', () => {
    render(<BarFill value={30} max={200} />);
    const meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute('aria-valuenow', '30');
    expect(meter).toHaveAttribute('aria-valuemin', '0');
    expect(meter).toHaveAttribute('aria-valuemax', '200');
  });

  it('handles max=0 without dividing by zero', () => {
    const { container } = render(<BarFill value={10} max={0} />);
    const fill = container.querySelector('[style]') as HTMLElement;
    expect(fill.style.width).toBe('100%');
  });
});
