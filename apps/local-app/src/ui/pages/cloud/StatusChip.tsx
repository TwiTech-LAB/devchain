import { Badge } from '@/ui/components/ui/badge';
import { Spinner } from '@/ui/components/ui/spinner';
import { TONE_CLASSES, type StatusTone } from '@/ui/lib/status-tone';
import { cn } from '@/ui/lib/utils';

/** A `running` tone shows a spinner next to the label; every other tone shows none. */
export function ToneSpinner({ tone }: { tone: StatusTone }) {
  return tone === 'running' ? <Spinner className="h-3 w-3" /> : null;
}

export function StatusChip({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Badge variant="outline" className={cn('gap-1 font-medium', TONE_CLASSES[tone], className)}>
      <ToneSpinner tone={tone} />
      {children}
    </Badge>
  );
}
