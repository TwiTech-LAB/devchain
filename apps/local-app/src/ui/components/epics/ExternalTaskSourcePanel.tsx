import { ExternalLink, Link2 } from 'lucide-react';
import type { ExternalTaskSourceSummary } from '@/modules/external-integrations/models/external-provider.models';
import { Badge } from '@/ui/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { externalBoardProviderLabel, safeExternalTaskUrl } from '@/ui/lib/external-board';

export function ExternalTaskSourcePanel({ items }: { items: ExternalTaskSourceSummary[] }) {
  if (items.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-5 w-5" aria-hidden="true" /> External source
        </CardTitle>
        <CardDescription>Remote task linked when this DevChain task was created.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {items.map((item) => {
          const sourceUrl = safeExternalTaskUrl(item.provider, item.webUrl);
          return (
            <div
              key={`${item.provider}:${item.remoteTaskId}`}
              className="space-y-2 rounded-md border bg-muted/20 p-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{externalBoardProviderLabel(item.provider)}</Badge>
                <span className="font-mono text-xs text-muted-foreground">{item.remoteKey}</span>
              </div>
              <p className="font-medium">{item.title}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Work area</dt>
                <dd>{item.workAreaName}</dd>
                <dt className="text-muted-foreground">Remote status</dt>
                <dd>{item.statusName}</dd>
              </dl>
              {sourceUrl ? (
                <a
                  href={sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
                >
                  Open source task <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              ) : (
                <p className="text-xs text-muted-foreground">Source link unavailable</p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
