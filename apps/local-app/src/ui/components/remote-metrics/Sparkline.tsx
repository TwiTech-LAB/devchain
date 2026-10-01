export interface SparklinePoint {
  x: number;
  y: number;
}

export const SPARKLINE_WIDTH = 56;
export const SPARKLINE_HEIGHT = 20;

// Keeps the last-point dot and value extremes inside the viewBox instead of clipping.
const POINT_INSET = 2;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Maps values onto the sparkline box: x spread evenly across the width, y scaled to the
 * series min/max. A flat series (no range) centers at half height so it stays visible.
 * All coordinates are rounded to one decimal, including the single-point case.
 */
export function buildSparklinePoints(
  values: readonly number[],
  width: number = SPARKLINE_WIDTH,
  height: number = SPARKLINE_HEIGHT,
): SparklinePoint[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const innerWidth = width - POINT_INSET * 2;
  const innerHeight = height - POINT_INSET * 2;
  return values.map((value, index) => {
    const x =
      values.length === 1 ? width / 2 : POINT_INSET + (innerWidth * index) / (values.length - 1);
    const normalized = range === 0 ? 0.5 : (value - min) / range;
    const y = POINT_INSET + (1 - normalized) * innerHeight;
    return { x: round1(x), y: round1(y) };
  });
}

function toPointsString(points: readonly SparklinePoint[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(' ');
}

export type SparklineColorVar = '--metric-cpu' | '--metric-ram' | '--metric-disk';

export function Sparkline({
  values,
  colorVar,
}: {
  values: readonly number[];
  colorVar: SparklineColorVar;
}) {
  const points = buildSparklinePoints(values);
  const last = points.length > 0 ? points[points.length - 1] : null;
  const line = points.length > 1 ? toPointsString(points) : null;

  return (
    <svg
      className="remote-sparkline"
      width={SPARKLINE_WIDTH}
      height={SPARKLINE_HEIGHT}
      viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
      style={{ color: `hsl(var(${colorVar}))` }}
      aria-hidden="true"
    >
      {line && last && (
        <>
          <polygon
            points={`${points[0].x},${SPARKLINE_HEIGHT} ${line} ${last.x},${SPARKLINE_HEIGHT}`}
            fill="currentColor"
            fillOpacity={0.12}
          />
          <polyline
            points={line}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.25}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </>
      )}
      {last && <circle cx={last.x} cy={last.y} r={1.75} fill="currentColor" />}
    </svg>
  );
}
