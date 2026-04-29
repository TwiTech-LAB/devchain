import type { ReactNode } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { cn } from '@/ui/lib/utils';

export interface HeatmapCellProps {
  value: number | null;
  max: number;
  size?: number;
  ariaLabel: string;
  onClick?: () => void;
  tooltip?: ReactNode;
  tabbable?: boolean;
}

function intensityClass(value: number | null, max: number): string {
  if (value === null) return 'border border-dashed border-border';
  if (value === 0) return 'border border-border';
  const safeMax = max > 0 ? max : 1;
  const ratio = Math.min(1, value / safeMax);
  if (ratio < 0.25) return 'bg-primary/25';
  if (ratio < 0.5) return 'bg-primary/50';
  if (ratio < 0.75) return 'bg-primary/75';
  return 'bg-primary';
}

export function HeatmapCell({
  value,
  max,
  size = 16,
  ariaLabel,
  onClick,
  tooltip,
  tabbable,
}: HeatmapCellProps) {
  const fill = intensityClass(value, max);

  const cell = <div style={{ width: size, height: size }} className={cn('rounded-[2px]', fill)} />;

  const hasOnClick = onClick !== undefined;
  const hasTooltip = tooltip !== undefined;

  const inner = hasOnClick ? (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="flex min-h-10 min-w-10 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {cell}
    </button>
  ) : (
    <div
      aria-label={ariaLabel}
      role="img"
      tabIndex={hasTooltip ? (tabbable ? 0 : -1) : undefined}
      className={cn(
        'inline-flex min-h-10 min-w-10 items-center justify-center',
        hasTooltip &&
          'cursor-default outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded-sm',
      )}
    >
      {cell}
    </div>
  );

  if (!hasTooltip) return inner;

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{inner}</TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
