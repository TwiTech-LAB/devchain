import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sparkline } from './Sparkline';

describe('Sparkline', () => {
  it('renders null for empty values', () => {
    const { container } = render(<Sparkline values={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a polyline for multiple values', () => {
    const { container } = render(<Sparkline values={[1, 2, 3, 4, 5]} />);
    expect(container.querySelector('polyline')).toBeInTheDocument();
  });

  it('polyline has one point per value', () => {
    const { container } = render(<Sparkline values={[10, 20, 30]} />);
    const poly = container.querySelector('polyline')!;
    const pts = poly.getAttribute('points')!.trim().split(' ');
    expect(pts).toHaveLength(3);
  });

  it('renders a single circle for one value', () => {
    const { container } = render(<Sparkline values={[5]} />);
    expect(container.querySelector('circle')).toBeInTheDocument();
    expect(container.querySelector('polyline')).not.toBeInTheDocument();
  });

  it('renders flat line at midY for constant values', () => {
    const { container } = render(<Sparkline values={[3, 3, 3]} height={20} />);
    const poly = container.querySelector('polyline')!;
    const pts = poly.getAttribute('points')!.trim().split(' ');
    pts.forEach((pt) => {
      const y = parseFloat(pt.split(',')[1]);
      expect(y).toBeCloseTo(10, 0);
    });
  });

  it('uses specified width and height on the SVG', () => {
    const { container } = render(<Sparkline values={[1, 2, 3]} width={120} height={30} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('120');
    expect(svg.getAttribute('height')).toBe('30');
  });

  it('aria-label includes min and max by default', () => {
    const { container } = render(<Sparkline values={[2, 7, 4]} />);
    const label = container.querySelector('svg')!.getAttribute('aria-label')!;
    expect(label).toMatch(/2/);
    expect(label).toMatch(/7/);
  });

  it('uses custom ariaLabel when provided', () => {
    const { container } = render(<Sparkline values={[1, 2]} ariaLabel="Churn trend" />);
    expect(container.querySelector('svg')!.getAttribute('aria-label')).toBe('Churn trend');
  });

  it('handles negative values without error', () => {
    const { container } = render(<Sparkline values={[-5, 0, 5]} />);
    expect(container.querySelector('polyline')).toBeInTheDocument();
  });

  it('shows aggregate tooltip text on focus', async () => {
    const { container } = render(<Sparkline values={[1, 2, 3, 4, 5]} />);
    const svg = container.querySelector('svg')!;
    fireEvent.focus(svg);
    const nodes = await screen.findAllByText(/total/i);
    expect(nodes.length).toBeGreaterThan(0);
  });

  describe('decorative mode', () => {
    it('decorative=true: aria-hidden true', () => {
      const { container } = render(<Sparkline values={[1, 2, 3]} decorative />);
      expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    });

    it('decorative=true: no tabIndex on SVG', () => {
      const { container } = render(<Sparkline values={[1, 2, 3]} decorative />);
      expect(container.querySelector('svg')!.getAttribute('tabindex')).toBeNull();
    });

    it('decorative=true: no role="img"', () => {
      const { container } = render(<Sparkline values={[1, 2, 3]} decorative />);
      expect(container.querySelector('svg')!.getAttribute('role')).toBeNull();
    });

    it('decorative=true: no aria-label', () => {
      const { container } = render(<Sparkline values={[1, 2, 3]} decorative ariaLabel="unused" />);
      expect(container.querySelector('svg')!.getAttribute('aria-label')).toBeNull();
    });

    it('decorative=true: no nested button (no TooltipTrigger)', () => {
      const { container } = render(<Sparkline values={[1, 2, 3]} decorative />);
      expect(container.querySelectorAll('button').length).toBe(0);
    });

    it('decorative=false (default): preserves tabIndex=0', () => {
      const { container } = render(<Sparkline values={[1, 2, 3]} />);
      expect(container.querySelector('svg')!.getAttribute('tabindex')).toBe('0');
    });

    it('decorative=false (default): preserves role="img"', () => {
      const { container } = render(<Sparkline values={[1, 2, 3]} />);
      expect(container.querySelector('svg')!.getAttribute('role')).toBe('img');
    });

    it('decorative=false (default): preserves aria-label', () => {
      const { container } = render(<Sparkline values={[1, 2, 3]} ariaLabel="My trend" />);
      expect(container.querySelector('svg')!.getAttribute('aria-label')).toBe('My trend');
    });
  });
});
