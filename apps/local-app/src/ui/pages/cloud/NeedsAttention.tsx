import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import type { AttentionAction, AttentionItem } from './remote-status';

/** What needs the user first: errors, then warnings and received VM notices. */
export function NeedsAttention({
  items,
  onAction,
  dismissPending = false,
  dismissError = null,
}: {
  items: AttentionItem[];
  onAction: (action: AttentionAction) => void;
  dismissPending?: boolean;
  dismissError?: string | null;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Needs attention</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-status-ok" />
            Nothing needs attention.
          </p>
        ) : (
          <ul aria-label="Needs attention" className="divide-y">
            {items.map((item) => {
              const Icon = item.tone === 'error' ? XCircle : AlertTriangle;
              return (
                <li
                  key={item.key}
                  className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 py-2"
                >
                  <p className="flex min-w-0 flex-1 items-start gap-2 text-sm">
                    <Icon
                      aria-hidden="true"
                      className={
                        item.tone === 'error'
                          ? 'mt-0.5 h-4 w-4 shrink-0 text-destructive'
                          : 'mt-0.5 h-4 w-4 shrink-0 text-status-warn'
                      }
                    />
                    <span className="break-words">{item.text}</span>
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {item.action && (
                      <Button size="sm" variant="outline" onClick={() => onAction(item.action!)}>
                        {item.action.label}
                      </Button>
                    )}
                    {item.secondaryAction && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={dismissPending}
                        onClick={() => onAction(item.secondaryAction!)}
                      >
                        {item.secondaryAction.label}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {dismissError && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {dismissError}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
