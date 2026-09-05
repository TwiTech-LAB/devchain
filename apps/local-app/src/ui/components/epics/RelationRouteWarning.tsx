import { TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';

/**
 * Shared destructive route / boundary warning. The lines come from the typed
 * 409 facts (or the linked-endpoint boundary state) and always include the
 * statement that historical provider time does not move.
 */
export function RelationRouteWarning({
  title,
  lines,
}: {
  title: string;
  lines: readonly string[];
}) {
  if (lines.length === 0) return null;
  return (
    <Alert role="alert">
      <TriangleAlert className="h-4 w-4" aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <span className="block space-y-1">
          {lines.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </span>
      </AlertDescription>
    </Alert>
  );
}
