import { Badge } from '@/ui/components/ui/badge';

/** The item count after a tab label, for example "VMs 3". */
export function CountBadge({ count }: { count: number }) {
  return (
    <Badge variant="secondary" className="ml-2 px-1.5 py-0 text-xs">
      {count}
    </Badge>
  );
}
