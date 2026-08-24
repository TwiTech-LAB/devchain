import { formatEpicTimeMinutes } from '@/ui/lib/epic-time';

/** Noninteractive estimated-time label for root Board items. */
export function EpicTimeBadge({ minutes }: { minutes: number }) {
  return (
    <span
      className="inline-flex flex-shrink-0 items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
      title="Estimated agent time"
      data-testid="epic-time-badge"
    >
      {formatEpicTimeMinutes(minutes)}
    </span>
  );
}
