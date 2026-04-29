import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon: LucideIcon;
  headline: string;
  reason?: string;
}

export function EmptyState({ icon: Icon, headline, reason }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-muted-foreground">
      <Icon className="h-8 w-8 opacity-40" aria-hidden="true" />
      <p className="text-sm font-medium">{headline}</p>
      {reason && <p className="max-w-xs text-xs opacity-70">{reason}</p>}
    </div>
  );
}
