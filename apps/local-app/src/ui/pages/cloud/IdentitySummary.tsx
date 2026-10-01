import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { useHomeIdentity, type HomeIdentity } from '@/ui/hooks/useHomeIdentity';
import { fetchRuntimeInfo } from '@/ui/lib/runtime';

const CLAIM_USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const CLAIM_HOME_ROOT = /^\/(home|Users|var\/home)\//;

/** Whether this PC's user name can set up a VM (the identity is read-only). */
function isValidClaimUserName(userName: string): boolean {
  return CLAIM_USER_NAME.test(userName);
}

/** Whether this PC's home folder can set up a VM (the identity is read-only). */
function isValidClaimHomePath(homePath: string): boolean {
  return CLAIM_HOME_ROOT.test(homePath);
}

/** Whether this PC's identity is known and can set up a VM. */
export function isClaimableIdentity(identity: HomeIdentity | undefined): boolean {
  return (
    identity !== undefined &&
    isValidClaimUserName(identity.user) &&
    isValidClaimHomePath(identity.homePath)
  );
}

/** Why this PC's read-only identity cannot set up a VM, if it cannot. */
function ClaimIdentityAlerts({ identity }: { identity: HomeIdentity | undefined }) {
  if (!identity) return null;
  return (
    <>
      {!isValidClaimUserName(identity.user) && (
        <p role="alert" className="text-sm text-destructive">
          This PC&apos;s user name &quot;{identity.user}&quot; cannot claim a VM: it must start with
          a lowercase letter or underscore and use lowercase letters, digits, - or _.
        </p>
      )}
      {!isValidClaimHomePath(identity.homePath) && (
        <p role="alert" className="text-sm text-destructive">
          This PC&apos;s home folder &quot;{identity.homePath}&quot; must start with /home/, /Users/
          or /var/home/ to claim a VM.
        </p>
      )}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  const id = useId();
  return (
    <div className="min-w-0">
      <dt id={id} className="text-xs text-muted-foreground">
        {label}
      </dt>
      <dd aria-labelledby={id} className="break-all font-medium">
        {value}
      </dd>
    </div>
  );
}

/**
 * What a VM always gets from this PC, read-only: the Linux user and home
 * folder (so stored absolute paths stay valid there), this DevChain's version
 * and port, and the global git settings.
 */
export function IdentitySummary() {
  const identity = useHomeIdentity();
  // The page reads the same entry, so the version is usually cached already.
  const runtime = useQuery(
    { queryKey: ['runtime-info'], queryFn: fetchRuntimeInfo, staleTime: Infinity },
    useHomeQueryClient(),
  );
  const port = typeof window !== 'undefined' ? window.location.port || '3000' : '3000';
  return (
    <section aria-label="This PC's identity on the VM" className="space-y-2">
      <dl className="grid grid-cols-2 gap-3 rounded-md border p-3 text-sm sm:grid-cols-4">
        <Fact label="Linux user" value={identity?.user ?? '—'} />
        <Fact label="Home folder" value={identity?.homePath ?? '—'} />
        <Fact label="DevChain version" value={runtime.data?.version ?? '—'} />
        <Fact label="Port" value={port} />
      </dl>
      <p className="text-xs text-muted-foreground">
        The VM always uses this PC&apos;s user and home folder, and gets this PC&apos;s global git
        settings at setup and at every Connect.
      </p>
      <ClaimIdentityAlerts identity={identity} />
    </section>
  );
}
