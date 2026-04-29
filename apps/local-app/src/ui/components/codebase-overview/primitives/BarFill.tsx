import { cn } from '@/ui/lib/utils';

interface BarFillProps {
  value: number | null | undefined;
  max: number;
  className?: string;
}

export function BarFill({ value, max, className }: BarFillProps) {
  const safeValue = value ?? 0;
  const safeMax = max > 0 ? max : 1;
  const pct = Math.min(100, Math.max(0, (safeValue / safeMax) * 100));

  return (
    <div
      role="meter"
      aria-valuenow={safeValue}
      aria-valuemin={0}
      aria-valuemax={max}
      data-testid="bar-fill"
      className="relative h-full w-full overflow-hidden rounded-sm bg-muted/40"
    >
      <div
        className={cn('h-full bg-primary/20 transition-[width] duration-300', className)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
