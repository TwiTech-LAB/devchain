import { Badge } from '@/ui/components/ui/badge';
import { TONE_CLASSES, type StatusTone } from '@/ui/lib/status-tone';
import { cn } from '@/ui/lib/utils';

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
    <Badge variant="outline" className={cn('font-medium', TONE_CLASSES[tone], className)}>
      {children}
    </Badge>
  );
}
