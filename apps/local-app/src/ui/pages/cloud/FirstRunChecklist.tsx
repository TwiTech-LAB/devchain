import { CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import type { RemoteReadinessDto } from '@/modules/remotes/dtos/remote-probe.dto';
import { Button } from '@/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';

/** A check's icon, colour and screen-reader state; an optional check only warns. */
function checkLook(ok: boolean | null, optional: boolean) {
  if (ok === null)
    return { Icon: CircleDashed, className: 'text-muted-foreground', state: 'checking' };
  if (ok) return { Icon: CheckCircle2, className: 'text-status-ok', state: 'ready' };
  return {
    Icon: XCircle,
    className: optional ? 'text-status-warn' : 'text-destructive',
    state: 'not ready',
  };
}

function CheckRow({
  label,
  ok,
  optional = false,
  detail,
}: {
  label: string;
  ok: boolean | null;
  optional?: boolean;
  detail: string | null;
}) {
  const { Icon, className, state } = checkLook(ok, optional);
  return (
    <li className="flex items-start gap-2 text-sm">
      <Icon aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${className}`} />
      <span className="min-w-0">
        <span className="font-medium">{label}</span>
        <span className="sr-only">{`: ${state}`}</span>
        {detail && <span className="block break-words text-muted-foreground">{detail}</span>}
      </span>
    </li>
  );
}

function Step({
  number,
  title,
  done = false,
  children,
}: {
  number: number;
  title: string;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      {done ? (
        <CheckCircle2 aria-hidden="true" className="mt-0.5 h-6 w-6 shrink-0 text-status-ok" />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium"
        >
          {number}
        </span>
      )}
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-medium">
          {title}
          {done && <span className="sr-only">: done</span>}
        </p>
        {children}
      </div>
    </li>
  );
}

/** The three steps of the first VM; shown while no project is bound to a VM. */
export function FirstRunChecklist({
  readiness,
  checking,
  error,
  vmExists,
  anyVmReady,
  onCheckAgain,
  onGoToVms,
  onConnect,
}: {
  readiness: RemoteReadinessDto | null;
  checking: boolean;
  error: Error | null;
  /** Step 2 shows as done once the first VM exists. */
  vmExists: boolean;
  anyVmReady: boolean;
  onCheckAgain: () => void;
  onGoToVms: () => void;
  onConnect: () => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Get started</CardTitle>
        <CardDescription>Run your projects on a VM in three steps.</CardDescription>
      </CardHeader>
      <CardContent>
        <ol aria-label="Get started" className="space-y-5">
          <Step number={1} title="Check this PC">
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error.message}
              </p>
            ) : (
              <ul aria-label="PC check" className="space-y-1.5">
                <CheckRow
                  label="Syncthing"
                  ok={readiness ? readiness.syncthing.ok : null}
                  detail={
                    readiness ? (readiness.syncthing.message ?? readiness.syncthing.version) : null
                  }
                />
                <CheckRow
                  label="Account and home folder"
                  ok={readiness ? readiness.identity.ok : null}
                  detail={
                    readiness
                      ? (readiness.identity.message ??
                        `${readiness.identity.user} · ${readiness.identity.homePath}`)
                      : null
                  }
                />
                <CheckRow
                  label="Docker (optional)"
                  optional
                  ok={readiness ? readiness.docker.ok : null}
                  detail={readiness?.docker.message ?? null}
                />
              </ul>
            )}
            <Button size="sm" variant="outline" onClick={onCheckAgain} disabled={checking}>
              {checking ? 'Checking…' : 'Check again'}
            </Button>
          </Step>
          <Step number={2} title="Add a VM" done={vmExists}>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={onGoToVms}>
                Go to VMs
              </Button>
            </div>
          </Step>
          <Step number={3} title="Connect a project">
            <Button size="sm" variant="outline" disabled={!anyVmReady} onClick={onConnect}>
              Connect a project
            </Button>
            {!anyVmReady && (
              <p className="text-xs text-muted-foreground">Available once a VM is ready.</p>
            )}
          </Step>
        </ol>
      </CardContent>
    </Card>
  );
}
