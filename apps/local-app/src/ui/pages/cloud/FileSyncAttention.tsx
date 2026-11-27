import { AlertTriangle } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { cn } from '@/ui/lib/utils';
import { WRAP, type FileSyncProjectItem } from './file-sync-display';
import { measuredSyncText } from './remote-status';

const NAMED = 3;

function detailText(items: readonly FileSyncProjectItem[]): string {
  if (items.length === 1) return `${items[0].project} · ${measuredSyncText(items[0].scope)}`;
  const names = items
    .slice(0, NAMED)
    .map((item) => item.project)
    .join(', ');
  const rest = items.length - NAMED;
  return rest > 0 ? `${names} and ${rest} more` : names;
}

/** The projects that need attention, in table order; nothing when there is none. */
export function FileSyncAttention({
  items,
  onView,
}: {
  items: readonly FileSyncProjectItem[];
  onView: () => void;
}) {
  if (items.length === 0) return null;
  const one = items.length === 1;
  const title = one ? '1 project needs attention' : `${items.length} projects need attention`;
  return (
    <section
      aria-label={title}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-status-warn/40 bg-status-warn/10 px-3 py-2 text-sm"
    >
      <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-status-warn" />
      <div className={cn('min-w-0 flex-1', WRAP)}>
        <p className="font-medium tabular-nums">{title}</p>
        <p>{detailText(items)}</p>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={onView}>
        {one ? 'View issue' : 'View issues'}
      </Button>
    </section>
  );
}
