import { useMemo } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { cn } from '@/ui/lib/utils';

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  ariaLabel?: string;
  className?: string;
  /** When true, renders as a bare decorative SVG (aria-hidden, no tabIndex, no tooltip).
   *  Use whenever Sparkline is nested inside an interactive parent (e.g. a button). */
  decorative?: boolean;
}

export function Sparkline({
  values,
  width = 80,
  height = 20,
  ariaLabel,
  className,
  decorative = false,
}: SparklineProps) {
  const derived = useMemo(() => {
    if (values.length === 0) return null;

    const min = Math.min(...values);
    const max = Math.max(...values);
    const total = values.reduce((a, b) => a + b, 0);
    const peakIdx = values.indexOf(max);
    const label = ariaLabel ?? `Trend: ${min}–${max}`;
    const tooltipText = `Last ${values.length} days: total ${total}, peak ${max} on day ${peakIdx + 1}`;

    if (values.length === 1) {
      return {
        type: 'single' as const,
        cx: width / 2,
        cy: height / 2,
        label,
        tooltipText,
      };
    }

    const range = max - min;
    const padV = 2;
    const drawH = Math.max(1, height - padV * 2);

    const points = values
      .map((v, i) => {
        const x = (i / (values.length - 1)) * width;
        const y = range === 0 ? height / 2 : padV + drawH - ((v - min) / range) * drawH;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');

    return { type: 'poly' as const, points, label, tooltipText };
  }, [values, width, height, ariaLabel]);

  if (derived === null) return null;

  const inner =
    derived.type === 'single' ? (
      <circle cx={derived.cx} cy={derived.cy} r={2} className="fill-foreground/70" />
    ) : (
      <polyline
        points={derived.points}
        fill="none"
        className="stroke-foreground/70"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );

  if (decorative) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
        className={cn('inline-block', className)}
      >
        {inner}
      </svg>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            aria-label={derived.label}
            role="img"
            tabIndex={0}
            className={cn('inline-block cursor-default outline-none', className)}
          >
            {inner}
          </svg>
        </TooltipTrigger>
        <TooltipContent>
          <p>{derived.tooltipText}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
