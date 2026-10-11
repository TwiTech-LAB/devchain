import { useState } from 'react';
import type {
  DockerOwnershipDecision,
  DockerPlanItem,
  DockerUserFixProposal,
} from '@/modules/remotes/docker/docker-plan.dto';
import { Button } from '@/ui/components/ui/button';
import { userIds } from '@/modules/remotes/vm-user-identity';

/** "web (web-1)": the Compose service, with its container when it has one. */
export function proposalService(proposal: DockerUserFixProposal): string {
  return proposal.container ? `${proposal.service} (${proposal.container})` : proposal.service;
}

/** "compose.yaml:4"; the line follows the file only when the proposal has one. */
export function proposalLocation(proposal: DockerUserFixProposal): string {
  return `${proposal.file ?? ''}${proposal.line !== null ? `:${proposal.line}` : ''}`;
}

export function DockerUserFix({
  proposal,
  imageHint = false,
  disabled,
  onApply,
  onVerify,
}: {
  proposal: DockerUserFixProposal;
  imageHint?: boolean;
  disabled: boolean;
  onApply: (proposal: DockerUserFixProposal) => void;
  onVerify: () => void;
}) {
  const [manual, setManual] = useState(false);
  const who = proposalService(proposal);
  return (
    <div aria-label={`User fix for ${who}`} className="space-y-2 rounded-md bg-muted/50 p-2">
      <p className="font-medium">
        {imageHint ? 'Image user hint' : 'Compose user fix'}: {who}
      </p>
      {proposal.file && <p className="break-all">{proposalLocation(proposal)}</p>}
      {imageHint ? (
        <pre className="overflow-x-auto">
          <code>user: {proposal.newUser}</code>
        </pre>
      ) : (
        <p className="break-all">
          <code>{proposal.oldUser ?? '(no user override)'}</code> → <code>{proposal.newUser}</code>
        </p>
      )}
      <p className="text-muted-foreground">{proposal.hint}</p>
      {proposal.reason && <p className="text-muted-foreground">{proposal.reason}</p>}
      {manual && (
        <p>Edit the Compose service&apos;s user line shown above, save it, then Verify.</p>
      )}
      <div className="flex flex-wrap gap-2">
        {proposal.canApply && !imageHint && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => onApply(proposal)}
          >
            Apply
          </Button>
        )}
        {!imageHint && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setManual(true)}
          >
            I&apos;ll do it myself
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onVerify}>
          Verify
        </Button>
      </div>
    </div>
  );
}

/** What a follows-user decision does to the container, by where the item's data ends up. */
function followsUserLine(dataOnly: boolean, retained: boolean | undefined): string {
  if (dataOnly) return 'Data only; no container is created. The configured VM user is';
  if (retained) {
    return "Replacing or resetting this group's data recreates it as your user on the VM";
  }
  return 'Runs as your user on the VM';
}

function OwnershipDecision({
  ownership,
  service,
  retained,
  dataOnly,
  disabled,
  onApply,
  onVerify,
}: {
  ownership: DockerOwnershipDecision;
  service?: string;
  retained?: boolean;
  dataOnly: boolean;
  disabled: boolean;
  onApply: (proposal: DockerUserFixProposal) => void;
  onVerify: () => void;
}) {
  return (
    <div className="space-y-1">
      {ownership.class === 'follows-user' && (
        <p>
          {service && `${service}: `}
          {followsUserLine(dataOnly, retained)} (
          {ownership.target?.user ?? userIds(ownership.vm.uid, ownership.vm.gid)}).
        </p>
      )}
      {ownership.fixProposal && (
        <DockerUserFix
          proposal={ownership.fixProposal}
          imageHint={ownership.class === 'image-user-hint'}
          disabled={disabled}
          onApply={onApply}
          onVerify={onVerify}
        />
      )}
      {ownership.refusalReasons?.map((reason) => (
        <p key={`${reason.code}:${reason.message}`} className="text-destructive">
          {reason.message}
        </p>
      ))}
    </div>
  );
}

/** The item's ownership decisions: one per Compose service, else the item's own. */
export function ownershipDecisions(
  item: DockerPlanItem,
): Array<{ service: string | undefined; ownership: DockerOwnershipDecision }> {
  if (item.serviceOwnership?.length) return item.serviceOwnership;
  if (item.ownership) return [{ service: undefined, ownership: item.ownership }];
  return [];
}

export function DockerOwnershipDetails({
  item,
  dataOnly,
  disabled,
  onApply,
  onVerify,
}: {
  item: DockerPlanItem;
  dataOnly: boolean;
  disabled: boolean;
  onApply: (proposal: DockerUserFixProposal) => void;
  onVerify: () => void;
}) {
  return (
    <div className="space-y-2">
      {ownershipDecisions(item).map(({ service, ownership }) => (
        <OwnershipDecision
          key={service ?? item.id}
          service={service}
          retained={Boolean(item.retainedOwnership && item.targetAction === 'leave-as-is')}
          dataOnly={dataOnly}
          ownership={ownership}
          disabled={disabled}
          onApply={onApply}
          onVerify={onVerify}
        />
      ))}
      {item.retainedOwnership && (
        <div role="note" aria-label={`Retained user for ${item.name}`}>
          <p>
            The retained VM container runs as{' '}
            {item.vmUser === undefined
              ? (item.retainedOwnership.targetUser ?? 'not reported')
              : item.vmUser || 'root (default user)'}
            . Its recorded ownership is {item.retainedOwnership.class} (
            {userIds(item.retainedOwnership.home.uid, item.retainedOwnership.home.gid)} here;{' '}
            {userIds(item.retainedOwnership.vm.uid, item.retainedOwnership.vm.gid)} on the VM).
          </p>
          {item.notes.map((note) => (
            <p key={note} className="text-muted-foreground">
              {note}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
