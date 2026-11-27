import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/components/ui/collapsible';
import { cn } from '@/ui/lib/utils';
import { WRAP, bytesText, formatTime } from './file-sync-display';
import type { FileSyncStatusLink, FileSyncStatusResponse } from './lib/remote-vm-contracts';

type Dot = 'ok' | 'warn' | 'unknown';

const DOT_CLASSES: Record<Dot, string> = {
  ok: 'bg-status-ok',
  warn: 'bg-status-warn',
  unknown: 'bg-muted-foreground',
};

function StateDot({ dot }: { dot: Dot }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', DOT_CLASSES[dot])}
    />
  );
}

function linkSummary(link: FileSyncStatusLink): [string, Dot] {
  if (link.connected === null) return ['Connection unknown', 'unknown'];
  return link.connected ? ['Connected', 'ok'] : ['Not connected', 'warn'];
}

/** The state in the details panel: the summary, with the start time for a connected VM. */
function linkState(link: FileSyncStatusLink): string {
  if (!link.connected) return linkSummary(link)[0];
  return `Connected since ${link.since ? formatTime(link.since) : 'unknown'}`;
}

function LinkLine({ link, vm }: { link: FileSyncStatusLink; vm: string }) {
  return (
    <li className={cn('flex flex-wrap gap-x-3 gap-y-1', WRAP)}>
      <span className="font-medium">{vm}</span>
      <span>{linkState(link)}</span>
      {link.connected && (
        <>
          <span className="text-muted-foreground">{link.address ?? 'Address unknown'}</span>
          <span className="tabular-nums text-muted-foreground">
            Sent {bytesText(link.sentBytes)} · Received {bytesText(link.receivedBytes)} in this
            connection
          </span>
        </>
      )}
    </li>
  );
}

/** The state of Syncthing on this PC and of each VM link, with the measured facts on demand. */
export function FileSyncConnections({
  status,
  vmName,
}: {
  status: FileSyncStatusResponse;
  vmName: (remoteId: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const { syncthing, links } = status;
  const hasDetails = syncthing.running || links.length > 0;
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section aria-label="Connections" className="rounded-lg border text-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
          <span className="flex min-w-0 items-center gap-2">
            <StateDot dot={syncthing.running ? 'ok' : 'warn'} />
            <span className="font-medium">This PC</span>
            <span className="text-muted-foreground">
              {syncthing.running ? 'Running' : 'Not running'}
            </span>
          </span>
          {!syncthing.running && (
            <span className={cn('min-w-0', WRAP)}>
              {syncthing.error ?? 'Syncthing does not run on this PC.'}
            </span>
          )}
          {links.length > 0 && (
            <ul aria-label="VM connections" className="flex min-w-0 flex-wrap gap-2">
              {links.map((link) => {
                const [state, dot] = linkSummary(link);
                return (
                  <li
                    key={link.remoteId}
                    className={cn(
                      'flex min-w-0 items-center gap-2 rounded-full border px-2.5 py-0.5',
                      WRAP,
                    )}
                  >
                    <StateDot dot={dot} />
                    <span className="font-medium">{vmName(link.remoteId)}</span>
                    <span className="text-muted-foreground">{state}</span>
                  </li>
                );
              })}
            </ul>
          )}
          {hasDetails && (
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="ml-auto gap-1">
                Connection details
                <ChevronDown
                  aria-hidden="true"
                  className={cn('h-4 w-4 transition-transform', open && 'rotate-180')}
                />
              </Button>
            </CollapsibleTrigger>
          )}
        </div>
        <CollapsibleContent className="space-y-1 border-t px-3 py-2">
          {syncthing.running && (
            <p>Syncthing {syncthing.version ?? '(version unknown)'} runs on this PC</p>
          )}
          {links.length > 0 && (
            <ul className="space-y-1">
              {links.map((link) => (
                <LinkLine key={link.remoteId} link={link} vm={vmName(link.remoteId)} />
              ))}
            </ul>
          )}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
