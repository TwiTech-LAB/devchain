import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ProbeResultDto } from '@/modules/remotes/dtos/remote-probe.dto';
import {
  parseCertificateFingerprint,
  type RemoteListItemDto,
} from '@/modules/remotes/dtos/remote.dto';
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
import { Switch } from '@/ui/components/ui/switch';
import { useHomeIdentity } from '@/ui/hooks/useHomeIdentity';
import { useProviderAuth } from '@/ui/hooks/useProviderAuth';
import type { CreateRemoteInput } from '@/ui/hooks/useRemotes';
import type {
  ClaimRequestBody,
  InstallHostRequestBody,
  RemoteOperationDto,
} from '@/ui/hooks/useRemoteOperations';
import { getErrorMessage } from '@/ui/lib/toast-helpers';
import { DiskEstimate, SUPPORTED_VM_OS, VmRequirements, useDiskEstimate } from './DiskEstimate';
import { isClaimableIdentity } from './IdentitySummary';
import { InstallBlockStep } from './InstallBlockStep';
import {
  LOGIN_PROVIDERS,
  choiceLabel,
  defaultLoginChoice,
  setupProviderAuth,
} from './login-choices';
import { SetupLoginStep, useAddLoginLink, useLoginChoices } from './LoginChoiceStep';
import { addressHost, addressOrigin, hostPort, probeAddress } from './own-vm-address';
import { OwnVmReview } from './OwnVmReview';
import { OpenSetupNotice, ProbeOutcome, installerOutcome } from './ProbeOutcome';
import type { ProjectListData } from './ProjectList';
import { openHostOperation } from './remote-status';
import {
  EMPTY_SSH_DRAFT,
  SshCredentialFields,
  credentialsAreValid,
  toCredentials,
  type SshCredentialDraft,
} from './SshCredentialForms';
import { StartError } from './StartError';
import { SshPublicKeyField, sshPublicKeysBody, validSshPublicKeyDraft } from './SshPublicKeyField';

type InstallerResult = Extract<ProbeResultDto, { kind: 'installer' }>;

/** How the VM gets set up, once the address check chose it. */
type Plan =
  | { kind: 'claim'; bootstrapUrl: string; remoteId: string | null; viaBlock: boolean }
  | { kind: 'ssh'; remoteId: string | null }
  | { kind: 'block'; remoteId: string | null };

type Step = 'address' | 'ssh' | 'block' | 'logins' | 'review';

const STEP_LABELS: Record<Step, string> = {
  address: 'Address',
  ssh: 'Install over SSH',
  block: 'Install block',
  logins: 'Logins',
  review: 'Review',
};

function planSteps(plan: Plan | null): Step[] {
  if (!plan) return ['address'];
  if (plan.kind === 'ssh') return ['address', 'ssh', 'logins', 'review'];
  if (plan.kind === 'block' || plan.viaBlock) return ['address', 'block', 'logins', 'review'];
  return ['address', 'logins', 'review'];
}

type Check =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'done'; result: ProbeResultDto }
  | { status: 'error'; message: string };

const ADDRESS_HINT = 'Enter a host, host:port or https://host:port.';

/**
 * Adds a VM that the user runs: the address check decides whether it is
 * added as it is, set up through its waiting installer, or installed first
 * (over SSH, or with a block the user runs on the VM).
 */
export function AddOwnVmDialog({
  initialAddress,
  remotes,
  operations,
  projects,
  pending,
  error,
  onClose,
  onAddVm,
  onClaim,
  onInstall,
  onOpenActivity,
  onViewVm,
}: {
  /** Checked at once, for a VM row that is not set up. */
  initialAddress?: string;
  remotes: readonly RemoteListItemDto[];
  operations: readonly RemoteOperationDto[];
  projects: ProjectListData;
  pending: boolean;
  /** The refusal of the last request, shown above the buttons. */
  error: string | null;
  onClose: () => void;
  onAddVm: (input: CreateRemoteInput) => void;
  onClaim: (body: ClaimRequestBody) => void;
  onInstall: (body: InstallHostRequestBody) => void;
  onOpenActivity: (operationId: string) => void;
  onViewVm: (remoteId: string) => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [address, setAddress] = useState(initialAddress ?? '');
  const [check, setCheck] = useState<Check>({ status: 'idle' });
  const [step, setStep] = useState<Step>('address');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [nameInput, setNameInput] = useState<string | null>(null);
  const [installDocker, setInstallDocker] = useState(true);
  const [sshPublicKey, setSshPublicKey] = useState('');
  const [ssh, setSsh] = useState<SshCredentialDraft>(EMPTY_SSH_DRAFT);
  const [blockAnswer, setBlockAnswer] = useState<InstallerResult | null>(null);
  /** The block's installer, once it answered and can be set up. */
  const [blockReady, setBlockReady] = useState<InstallerResult | null>(null);
  const { entries } = useProviderAuth();
  const identity = useHomeIdentity();
  const projectIds = useMemo(() => projects.rows.map((row) => row.project.id), [projects.rows]);
  const estimate = useDiskEstimate(projectIds);

  const host = addressHost(address);
  const remoteNames = useMemo(
    () => new Map(remotes.map((remote) => [remote.id, remote.name])),
    [remotes],
  );
  // An install reuses the VM row at the same host.
  const rowAtHost = remotes.find(
    (remote) => remote.baseUrl !== null && host !== null && addressHost(remote.baseUrl) === host,
  );
  const knownRemoteId = plan?.remoteId ?? rowAtHost?.id;
  const name =
    nameInput ?? (knownRemoteId ? remoteNames.get(knownRemoteId) : undefined) ?? host ?? '';
  const openOperationOf = (remoteId: string | null | undefined) =>
    remoteId ? openHostOperation(operations, remoteId) : undefined;
  /** The VM row an installer belongs to: the one it names, else the row at its host. */
  const installerRemoteId = (result: InstallerResult) => result.remoteId ?? rowAtHost?.id;
  /** The VM whose open setup an address check shows. */
  const checkedRemoteId = (result: ProbeResultDto) => {
    if (result.kind === 'nothing') return rowAtHost?.id;
    if (result.kind === 'installer') return installerRemoteId(result);
    return null;
  };

  const context = useMemo(
    () => ({ targetRemoteId: plan?.remoteId ?? null, remoteNames }),
    [plan?.remoteId, remoteNames],
  );
  const defaultFor = useCallback(
    (provider: string) => defaultLoginChoice(provider, entries, context),
    [entries, context],
  );
  const { choices, setChoice } = useLoginChoices(LOGIN_PROVIDERS, defaultFor);
  const { onAddLogin, addLoginDialog } = useAddLoginLink(LOGIN_PROVIDERS, setChoice);

  const running = useRef<AbortController | null>(null);
  const runCheck = useCallback(async (value: string) => {
    running.current?.abort();
    if (!addressOrigin(value)) {
      setCheck({ status: 'error', message: ADDRESS_HINT });
      return;
    }
    const controller = new AbortController();
    running.current = controller;
    setCheck({ status: 'checking' });
    try {
      const result = await probeAddress(value.trim(), {
        checkSsh: true,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setCheck({ status: 'done', result });
    } catch (cause) {
      if (!controller.signal.aborted) {
        setCheck({
          status: 'error',
          message: getErrorMessage(cause, 'The address check failed.'),
        });
      }
    }
  }, []);
  useEffect(() => {
    if (initialAddress) void runCheck(initialAddress);
    return () => running.current?.abort();
  }, [initialAddress, runCheck]);

  const submitCheck = (event: FormEvent) => {
    event.preventDefault();
    void runCheck(address);
  };
  const editAddress = (value: string) => {
    setAddress(value);
    setApiKey('');
    setFingerprint('');
    running.current?.abort();
    setCheck({ status: 'idle' });
    setPlan(null);
  };

  const setUpInstaller = (result: InstallerResult, viaBlock: boolean) => {
    setPlan({
      kind: 'claim',
      bootstrapUrl: result.bootstrapUrl,
      remoteId: installerRemoteId(result) ?? null,
      viaBlock,
    });
    setStep('logins');
  };
  const onBlockInstaller = (result: InstallerResult) => {
    const outcome = installerOutcome(result, openOperationOf(installerRemoteId(result)));
    if (outcome.kind === 'ready') {
      setBlockAnswer(null);
      setBlockReady(result);
      return true;
    }
    setBlockAnswer(result);
    return false;
  };

  const steps = planSteps(plan);
  const back = () => {
    const index = steps.indexOf(step);
    const previous = steps[index - 1] ?? 'address';
    if (previous === 'address') {
      setStep('address');
      setPlan(null);
      setBlockReady(null);
    } else {
      setStep(previous);
    }
  };

  const claimable = isClaimableIdentity(identity);
  const sshReady = credentialsAreValid(ssh) && estimate.requiredDisk !== null;
  const keyValid = validSshPublicKeyDraft(sshPublicKey);
  const parsedFingerprint = parseCertificateFingerprint(fingerprint);
  const canStart =
    !pending &&
    claimable &&
    keyValid &&
    plan !== null &&
    (plan.kind !== 'ssh' || sshReady) &&
    (plan.kind !== 'claim' || parsedFingerprint !== null);
  const providerAuth = setupProviderAuth(choices);
  const loginSummary = Object.entries(providerAuth).map(([provider, choice]) => ({
    provider,
    label: choiceLabel(provider, choice, entries, context),
  }));

  const start = () => {
    if (!canStart || !plan) return;
    const trimmedName = name.trim() || undefined;
    if (plan.kind === 'claim') {
      if (!parsedFingerprint) return;
      onClaim({
        baseUrl: plan.bootstrapUrl,
        certificateFingerprint: parsedFingerprint,
        name: trimmedName,
        providerAuth,
        ...sshPublicKeysBody(sshPublicKey),
        ...(installDocker ? { installDocker: true } : {}),
      });
      return;
    }
    onInstall({
      address: addressOrigin(address)!,
      ssh: toCredentials(ssh),
      name: trimmedName,
      providerAuth,
      ...sshPublicKeysBody(sshPublicKey),
      ...(installDocker ? { installDocker: true } : {}),
      minDiskGib: estimate.requiredDisk!,
    });
    // The credentials are sent once; a new attempt asks for them again.
    setSsh((current) => ({ ...EMPTY_SSH_DRAFT, user: current.user }));
  };

  const blockNotice = (() => {
    if (!blockAnswer) return null;
    const outcome = installerOutcome(blockAnswer, openOperationOf(installerRemoteId(blockAnswer)));
    if (outcome.kind === 'unsupported') {
      return (
        <p role="alert" className="text-destructive">
          {outcome.message}
        </p>
      );
    }
    if ((outcome.kind === 'running' || outcome.kind === 'stopped') && outcome.operation) {
      return <OpenSetupNotice operation={outcome.operation} onOpenActivity={onOpenActivity} />;
    }
    return <p>Setup is already running on this VM.</p>;
  })();

  const stepIndex = steps.indexOf(step);

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] overflow-y-auto sm:w-full sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add your own VM</DialogTitle>
          <DialogDescription>
            {steps.length > 1
              ? `Step ${stepIndex + 1} of ${steps.length}: ${STEP_LABELS[step]}`
              : 'Enter the VM’s address. DevChain checks what answers there.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'address' && (
          <div className="space-y-3">
            <form onSubmit={submitCheck} className="flex flex-wrap items-end gap-2">
              <div className="min-w-[14rem] flex-1 space-y-1.5">
                <Label htmlFor="own-vm-address">VM address</Label>
                <Input
                  id="own-vm-address"
                  value={address}
                  onChange={(event) => editAddress(event.target.value)}
                  placeholder="192.168.1.20, 192.168.1.20:3000 or https://vm.lan"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending}
                />
              </div>
              <Button
                type="submit"
                variant={check.status === 'done' ? 'outline' : 'default'}
                disabled={pending || address.trim() === ''}
                pending={check.status === 'checking'}
              >
                {check.status === 'checking' ? 'Checking…' : 'Check'}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">Supported OS: {SUPPORTED_VM_OS}.</p>
            {check.status === 'error' && (
              <p role="alert" className="text-sm text-destructive">
                {check.message}
              </p>
            )}
            {check.status === 'done' && (
              <ProbeOutcome
                result={check.result}
                openOperation={openOperationOf(checkedRemoteId(check.result))}
                remoteNames={remoteNames}
                apiKey={apiKey}
                onApiKeyChange={setApiKey}
                fingerprint={fingerprint}
                onFingerprintChange={setFingerprint}
                name={name}
                onNameChange={setNameInput}
                pending={pending}
                onAddVm={(baseUrl) => {
                  if (!parsedFingerprint) return;
                  onAddVm({
                    name: name.trim(),
                    baseUrl,
                    apiKey: apiKey.trim(),
                    certificateFingerprint: parsedFingerprint,
                  });
                }}
                onViewVm={onViewVm}
                onOpenActivity={onOpenActivity}
                onSetUpInstaller={(result) => setUpInstaller(result, false)}
                onInstallOverSsh={() => {
                  setPlan({ kind: 'ssh', remoteId: rowAtHost?.id ?? null });
                  setStep('ssh');
                }}
                onRunBlock={() => {
                  setBlockAnswer(null);
                  setBlockReady(null);
                  setFingerprint('');
                  setPlan({ kind: 'block', remoteId: rowAtHost?.id ?? null });
                  setStep('block');
                }}
              />
            )}
          </div>
        )}

        {step === 'ssh' && (
          <div className="space-y-4">
            <section aria-label="SSH sign-in" className="space-y-2">
              <p className="text-sm text-muted-foreground">
                The SSH user needs sudo on the VM. If it matches this PC&apos;s user name, the setup
                reuses that account and grants it passwordless sudo. Credentials are used only for
                this install.
              </p>
              <SshCredentialFields
                draft={ssh}
                setDraft={setSsh}
                idPrefix="own-vm-ssh"
                disabled={pending}
              />
            </section>
            <VmRequirements estimate={estimate} />
            <DiskEstimate estimate={estimate} projects={projects} disabled={pending} />
            <div className="flex items-center gap-2">
              <Switch
                id="own-vm-ssh-docker"
                checked={installDocker}
                onCheckedChange={setInstallDocker}
                disabled={pending}
              />
              <Label htmlFor="own-vm-ssh-docker">Install Docker</Label>
            </div>
          </div>
        )}

        {step === 'block' && (
          <InstallBlockStep
            address={address}
            minDiskGib={estimate.requiredDisk ?? 8}
            notice={blockNotice}
            onInstaller={onBlockInstaller}
            ready={blockReady !== null}
            fingerprint={fingerprint}
            onFingerprintChange={setFingerprint}
            onContinue={() => blockReady && setUpInstaller(blockReady, true)}
          />
        )}

        {step === 'logins' && (
          <div className="space-y-2">
            <SetupLoginStep
              onAddLogin={onAddLogin}
              entries={entries}
              context={context}
              choices={choices}
              onChange={setChoice}
              disabled={pending}
            />
            <SshPublicKeyField
              user={identity?.user}
              value={sshPublicKey}
              onChange={setSshPublicKey}
              disabled={pending}
            />
          </div>
        )}

        {step === 'review' && plan && (
          <OwnVmReview
            vm={host ?? address}
            how={
              plan.kind === 'claim'
                ? `Set up the installer at ${hostPort(plan.bootstrapUrl)}`
                : `Install over SSH as ${ssh.user.trim()}, then set up`
            }
            logins={loginSummary}
            hasSshPublicKey={sshPublicKey.trim().length > 0}
            name={name}
            onNameChange={setNameInput}
            installDocker={installDocker}
            onInstallDockerChange={plan.kind === 'claim' ? setInstallDocker : undefined}
            freeDisk={
              plan.kind === 'ssh' && estimate.requiredDisk !== null
                ? `${estimate.requiredDisk} GiB`
                : undefined
            }
            disabled={pending}
          />
        )}

        {plan?.kind === 'ssh' && step === 'review' && !credentialsAreValid(ssh) && (
          <p role="alert" className="text-sm text-destructive">
            Go back and enter the SSH credentials again.
          </p>
        )}
        <StartError error={error} />
        {addLoginDialog}
        <DialogFooter>
          {step === 'address' ? (
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={back} disabled={pending}>
              Back
            </Button>
          )}
          {step === 'ssh' && (
            <Button type="button" onClick={() => setStep('logins')} disabled={!sshReady}>
              Next
            </Button>
          )}
          {step === 'logins' && (
            <Button type="button" onClick={() => setStep('review')} disabled={pending || !keyValid}>
              Next
            </Button>
          )}
          {step === 'review' && (
            <Button
              type="button"
              onClick={start}
              disabled={!canStart}
              pending={pending}
              data-testid="own-vm-start"
            >
              {pending ? 'Starting…' : plan?.kind === 'claim' ? 'Set up VM' : 'Install and set up'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
