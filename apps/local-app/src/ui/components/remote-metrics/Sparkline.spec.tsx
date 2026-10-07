import { render } from '@testing-library/react';
import { Sparkline, buildSparklinePoints, SPARKLINE_HEIGHT } from './Sparkline';

describe('buildSparklinePoints', () => {
  it('returns no points for an empty series', () => {
    expect(buildSparklinePoints([])).toEqual([]);
  });

  it('places a single point at the center with rounded coordinates', () => {
    expect(buildSparklinePoints([41.2])).toEqual([{ x: 28, y: 10 }]);
  });

  it('maps sample positions across the plot', () => {
    const points = buildSparklinePoints([0, 1, 0]);
    {
      expect(points.map((point) => point.x)).toEqual([2, 28, 54]);
    }
    {
      expect(points[0].y).toBe(18);
      expect(points[1].y).toBe(2);
      expect(points[2].y).toBe(18);
    }
  });

  it('centers a flat series at half height', () => {
    const points = buildSparklinePoints([7, 7, 7, 7]);
    expect(points.every((point) => point.y === 10)).toBe(true);
  });

  it('rounds every coordinate to one decimal', () => {
    const points = buildSparklinePoints([1, 2, 3, 4, 5, 6, 7]);
    expect(points).toHaveLength(7);
    for (const point of points) {
      expect(point.x).toBe(Math.round(point.x * 10) / 10);
      expect(point.y).toBe(Math.round(point.y * 10) / 10);
    }
    // 52px of inner width over 6 steps is 8.66…px per step; rounding keeps one decimal.
    expect(points[1].x).toBe(10.7);
    expect(points[2].x).toBe(19.3);
  });

  it('honors custom width and height', () => {
    const points = buildSparklinePoints([0, 1], 100, 40);
    expect(points).toEqual([
      { x: 2, y: 38 },
      { x: 98, y: 2 },
    ]);
  });
});

describe('Sparkline', () => {
  it('colors the line, area and dot through the metric CSS variable', () => {
    const { container } = render(<Sparkline values={[1, 2, 3]} colorVar="--metric-ram" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveStyle({ color: 'hsl(var(--metric-ram))' });
  });

  it('draws the line, area fill and last-point dot', () => {
    const { container } = render(<Sparkline values={[0, 1, 0]} colorVar="--metric-cpu" />);
    {
      const polyline = container.querySelector('polyline');
      expect(polyline).not.toBeNull();
      expect(polyline).toHaveAttribute('points', '2,18 28,2 54,18');
      const polygon = container.querySelector('polygon');
      expect(polygon).not.toBeNull();
      expect(polygon).toHaveAttribute(
        'points',
        `2,${SPARKLINE_HEIGHT} 2,18 28,2 54,18 54,${SPARKLINE_HEIGHT}`,
      );
    }
    {
      const circle = container.querySelector('circle');
      expect(circle).not.toBeNull();
      expect(circle).toHaveAttribute('cx', '54');
      expect(circle).toHaveAttribute('cy', '18');
    }
  });

  it('renders only the centered dot for a single value', () => {
    const { container } = render(<Sparkline values={[5]} colorVar="--metric-disk" />);
    expect(container.querySelector('polyline')).toBeNull();
    expect(container.querySelector('polygon')).toBeNull();
    const circle = container.querySelector('circle');
    expect(circle).toHaveAttribute('cx', '28');
    expect(circle).toHaveAttribute('cy', '10');
  });
});
