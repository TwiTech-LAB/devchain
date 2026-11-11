import { useCallback, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { Alert, AlertDescription } from '@/ui/components/ui/alert';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { useHomeSocket } from '@/ui/hooks/useHomeSocket';
import { useToast } from '@/ui/hooks/use-toast';
import type { WsEnvelope } from '@/ui/lib/socket';
import { vaultQueryKeys } from '@/ui/lib/vault';
import {
  VAULT_REQUEST_FRAME_TYPES,
  approveVaultRequest,
  denyVaultRequest,
  fetchVaultRequests,
  fulfillVaultRequest,
  vaultRequestsQueryKey,
  type VaultRequestView,
  type VaultUseDecision,
} from '@/ui/lib/vault-requests';
import { FormError, ValueField } from './VaultEntryDialogs';

/**
 * Asks the user to answer agent requests for Vault entries, one at a time, on any page.
 * The home list is the source of truth: socket frames and reconnects only refetch it.
 */
export function VaultRequestModal() {
  const queryClient = useHomeQueryClient();
  const { data: pending = [] } = useQuery(
    { queryKey: vaultRequestsQueryKey, queryFn: fetchVaultRequests },
    queryClient,
  );
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: vaultRequestsQueryKey });
  }, [queryClient]);
  const onFrame = useCallback(
    (envelope: WsEnvelope) => {
      if (VAULT_REQUEST_FRAME_TYPES.has(envelope?.type)) refresh();
    },
    [refresh],
  );
  useHomeSocket({ connect: refresh, message: onFrame }, [refresh, onFrame]);

  // "Later" hides a request until the page reloads or the backend view switches
  // (the modal remounts inside BackendBoundary); the request stays pending on home.
  const [later, setLater] = useState<ReadonlySet<string>>(new Set());
  const current = pending.find((request) => !later.has(request.requestId)) ?? null;
  const postpone = (requestId: string) => setLater((prev) => new Set(prev).add(requestId));

  return (
    <Dialog
      open={current !== null}
      onOpenChange={(open) => {
        if (!open && current) postpone(current.requestId);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        {current ? (
          <AnswerForm
            key={current.requestId}
            request={current}
            onAnswered={() => {
              refresh();
              void queryClient.invalidateQueries({ queryKey: vaultQueryKeys.all() });
            }}
            onLater={() => postpone(current.requestId)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface AnswerFormProps {
  request: VaultRequestView;
  onAnswered: () => void;
  onLater: () => void;
}

function AnswerForm(props: AnswerFormProps) {
  return props.request.type === 'use' ? <UseRequestForm {...props} /> : <RequestForm {...props} />;
}

function RequestContext({ request, what }: { request: VaultRequestView; what: string }) {
  return (
    <DialogDescription>
      {request.projectName}
      {request.remoteName ? ` · on VM ${request.remoteName}` : null} · role{' '}
      {request.familySlug ?? 'none'} · {what}
    </DialogDescription>
  );
}

function DenyReasonField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor="vault-request-reason">Reason if you deny (optional)</Label>
      <Input
        id="vault-request-reason"
        maxLength={200}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function AgentReason({ description }: { description: string }) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">Why the agent needs it</p>
      <p className="whitespace-pre-wrap text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function LaterDenyButtons({
  busy,
  onLater,
  onDeny,
}: {
  busy: boolean;
  onLater: () => void;
  onDeny: () => void;
}) {
  return (
    <>
      <Button type="button" variant="ghost" onClick={onLater} disabled={busy}>
        Later
      </Button>
      <Button type="button" variant="outline" onClick={onDeny} disabled={busy}>
        Deny
      </Button>
    </>
  );
}

function useDenyRequest(request: VaultRequestView, onAnswered: () => void) {
  const { toast } = useToast();
  return useMutation(
    {
      mutationFn: (reason: string) =>
        denyVaultRequest(request.requestId, reason.trim() || undefined),
      onSuccess: () => {
        toast({ title: `Denied ${request.name} to ${request.agentName}.` });
        onAnswered();
      },
      onError: () => onAnswered(),
    },
    useHomeQueryClient(),
  );
}

const USE_APPROVED_TITLE: Record<VaultUseDecision, (request: VaultRequestView) => string> = {
  session: (r) => `${r.agentName} can use ${r.name} in this session.`,
  once: (r) => `${r.agentName} can use ${r.name} once.`,
  family: (r) => `Agents of role ${r.familySlug} can use ${r.name} without asking.`,
};

/** A session asks to use a granted entry that requires approval; no value is shown or sent. */
function UseRequestForm({ request, onAnswered, onLater }: AnswerFormProps) {
  const { toast } = useToast();
  const queryClient = useHomeQueryClient();
  const [reason, setReason] = useState('');
  const approve = useMutation(
    {
      mutationFn: (decision: VaultUseDecision) => approveVaultRequest(request.requestId, decision),
      onSuccess: (_result, decision) => {
        toast({ title: USE_APPROVED_TITLE[decision](request) });
        onAnswered();
      },
      onError: () => onAnswered(),
    },
    queryClient,
  );
  const deny = useDenyRequest(request, onAnswered);
  const busy = approve.isPending || deny.isPending;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    approve.mutate('session');
  };

  return (
    <form onSubmit={handleSubmit} autoComplete="off" className="space-y-4">
      <DialogHeader>
        <DialogTitle>
          Agent {request.agentName} wants to use <span className="font-mono">{request.name}</span>
        </DialogTitle>
        <RequestContext request={request} what={`${request.kind} entry that requires approval`} />
      </DialogHeader>

      {request.entryDescription ? (
        <div className="space-y-1">
          <p className="text-sm font-medium">Entry</p>
          <p className="text-sm text-muted-foreground">{request.entryDescription}</p>
        </div>
      ) : null}
      {request.description ? <AgentReason description={request.description} /> : null}
      {request.kind === 'file' ? (
        <p className="text-sm text-muted-foreground">
          A file stays on disk for the session, so it cannot be approved once.
        </p>
      ) : null}

      <DenyReasonField value={reason} onChange={setReason} disabled={busy} />

      <FormError error={approve.error ?? deny.error} />
      <DialogFooter className="flex-wrap gap-2">
        <LaterDenyButtons busy={busy} onLater={onLater} onDeny={() => deny.mutate(reason)} />
        {request.familySlug === null ? null : (
          <Button
            type="button"
            variant="outline"
            onClick={() => approve.mutate('family')}
            disabled={busy}
          >
            Never ask for this role
          </Button>
        )}
        {request.kind === 'file' ? null : (
          <Button
            type="button"
            variant="outline"
            onClick={() => approve.mutate('once')}
            disabled={busy}
          >
            Approve once
          </Button>
        )}
        <Button type="submit" disabled={busy}>
          Approve for this session
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Same wording as the mobile sheet's submit button. */
function submitLabelFor(isCreate: boolean, permanent: boolean): string {
  if (!isCreate) return 'Grant access';
  return permanent ? 'Store and give' : 'Give for this session';
}

function RequestForm({ request, onAnswered, onLater }: AnswerFormProps) {
  const { toast } = useToast();
  const queryClient = useHomeQueryClient();
  const [value, setValue] = useState('');
  const [permanent, setPermanent] = useState(true);
  const [reason, setReason] = useState('');
  const isCreate = request.type === 'create';
  // A permanent answer is a grant to the requester's family; without one, to all agents.
  const allAgentsScope = request.familySlug === null && (permanent || !isCreate);

  const fulfill = useMutation(
    {
      // The mutationFn closure holds the secret; drop it from the MutationCache
      // as soon as the mutation settles instead of the default 5-minute gcTime.
      gcTime: 0,
      mutationFn: () =>
        fulfillVaultRequest(
          request.requestId,
          isCreate ? { value, permanent } : { permanent: true },
        ),
      onSuccess: () => {
        toast({ title: `${request.agentName} can now use ${request.name}.` });
        onAnswered();
      },
      onError: () => onAnswered(),
    },
    queryClient,
  );
  const deny = useDenyRequest(request, onAnswered);
  const busy = fulfill.isPending || deny.isPending;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isCreate && value === '') return;
    fulfill.mutate();
  };

  return (
    <form onSubmit={handleSubmit} autoComplete="off" className="space-y-4">
      <DialogHeader>
        <DialogTitle>
          {request.agentName} asks for <span className="font-mono">{request.name}</span>
        </DialogTitle>
        <RequestContext
          request={request}
          what={isCreate ? `new ${request.kind} entry` : 'access to an existing entry'}
        />
      </DialogHeader>

      <AgentReason description={request.description} />

      {isCreate ? (
        <>
          <ValueField
            id="vault-request-value"
            kind={request.kind}
            value={value}
            onChange={setValue}
            disabled={busy}
          />
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Keep the value</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="vault-request-scope"
                checked={permanent}
                onChange={() => setPermanent(true)}
              />
              Store in the Vault for this role
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="vault-request-scope"
                checked={!permanent}
                onChange={() => setPermanent(false)}
              />
              This session only (kept in memory until the session stops)
            </label>
          </fieldset>
        </>
      ) : (
        <div className="space-y-1">
          <p className="text-sm font-medium">Existing entry</p>
          <p className="font-mono text-sm">{request.name}</p>
          {request.entryDescription ? (
            <p className="text-sm text-muted-foreground">{request.entryDescription}</p>
          ) : null}
        </div>
      )}

      {allAgentsScope ? (
        <Alert variant="warn" className="py-2">
          <AlertDescription>
            {`${request.agentName}'s profile has no role, so this gives ${request.name} to all agents of ${request.projectName}.`}
            {isCreate ? ' Choose "This session only" to give it to this agent only.' : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <DenyReasonField value={reason} onChange={setReason} disabled={busy} />

      <FormError error={fulfill.error ?? deny.error} />
      <DialogFooter className="gap-2">
        <LaterDenyButtons busy={busy} onLater={onLater} onDeny={() => deny.mutate(reason)} />
        <Button type="submit" disabled={busy || (isCreate && value === '')}>
          {submitLabelFor(isCreate, permanent)}
        </Button>
      </DialogFooter>
    </form>
  );
}
