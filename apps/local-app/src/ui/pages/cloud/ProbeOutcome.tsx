import type { ProbeResultDto } from '@/modules/remotes/dtos/remote-probe.dto';
import { unsupportedHostImageMessage } from '@/modules/remotes/host-image';
import type { RemoteOperationDto } from '@/ui/hooks/useRemoteOperations';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { parseCertificateFingerprint } from '@/modules/remotes/dtos/remote.dto';
import { CertificateFingerprintField } from './CertificateFingerprintField';
import { hostPort, nothingSentence } from './own-vm-address';

type InstallerResult = Extract<ProbeResultDto, { kind: 'installer' }>;

/**
 * What an installer answer allows. An open setup of the same VM wins: a
 * failed one reserves the VM until Activity resolves it, so this flow never
 * starts a second setup next to it.
 */
export type InstallerOutcome =
  | { kind: 'ready' }
  | { kind: 'running'; operation: RemoteOperationDto | undefined }
  | { kind: 'stopped'; operation: RemoteOperationDto }
  | { kind: 'unsupported'; message: string };

export function installerOutcome(
  result: InstallerResult,
  openOperation: RemoteOperationDto | undefined,
): InstallerOutcome {
  if (openOperation?.state === 'failed') return { kind: 'stopped', operation: openOperation };
  if (openOperation || result.state !== 'unclaimed') {
    return { kind: 'running', operation: openOperation };
  }
  if (!result.supported) {
    return { kind: 'unsupported', message: unsupportedHostImageMessage(result.imageVersion) };
  }
  return { kind: 'ready' };
}

/** The running or stopped setup of this VM, and the way into its Activity. */
export function OpenSetupNotice({
  operation,
  onOpenActivity,
}: {
  operation: RemoteOperationDto;
  onOpenActivity: (operationId: string) => void;
}) {
  const stopped = operation.state === 'failed';
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p role={stopped ? 'alert' : 'status'} className={stopped ? 'text-destructive' : undefined}>
        {stopped
          ? 'Setup of this VM stopped. Resolve it in Activity before you set it up again.'
          : 'Setup is already running on this VM.'}
      </p>
      <Button
        type="button"
        size="sm"
        variant={stopped ? 'destructive' : 'outline'}
        onClick={() => onOpenActivity(operation.id)}
      >
        {stopped ? 'Resolve' : 'Open Activity'}
      </Button>
    </div>
  );
}

/** The next step for an address check's answer. */
export function ProbeOutcome({
  result,
  openOperation,
  remoteNames,
  apiKey,
  onApiKeyChange,
  fingerprint,
  onFingerprintChange,
  name,
  onNameChange,
  pending,
  onAddVm,
  onViewVm,
  onOpenActivity,
  onSetUpInstaller,
  onInstallOverSsh,
  onRunBlock,
}: {
  result: ProbeResultDto;
  /** The open host operation of the VM row at this address, if any. */
  openOperation: RemoteOperationDto | undefined;
  remoteNames: ReadonlyMap<string, string>;
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  /** The certificate fingerprint as pasted; nothing goes on until it parses. */
  fingerprint: string;
  onFingerprintChange: (value: string) => void;
  name: string;
  onNameChange: (name: string) => void;
  pending: boolean;
  onAddVm: (baseUrl: string) => void;
  onViewVm: (remoteId: string) => void;
  onOpenActivity: (operationId: string) => void;
  onSetUpInstaller: (result: InstallerResult) => void;
  onInstallOverSsh: () => void;
  onRunBlock: () => void;
}) {
  const panel = 'space-y-3 rounded-md border p-3 text-sm';
  const fingerprintValid = parseCertificateFingerprint(fingerprint) !== null;
  const fingerprintField = (
    <CertificateFingerprintField
      id="own-vm-fingerprint"
      value={fingerprint}
      onChange={onFingerprintChange}
      disabled={pending}
    />
  );

  if (result.kind === 'devchain') {
    if (result.remoteId) {
      const listedAs = remoteNames.get(result.remoteId);
      return (
        <section aria-label="Address check" className={panel}>
          <p role="status">This VM is already in the list{listedAs ? ` as ${listedAs}` : ''}.</p>
          <Button type="button" size="sm" onClick={() => onViewVm(result.remoteId!)}>
            Open details
          </Button>
        </section>
      );
    }
    return (
      <section aria-label="Address check" className={panel}>
        <p role="status">
          DevChain {result.version ?? '(unknown version)'} answers at {hostPort(result.baseUrl)}.
        </p>
        {!result.versionMatches && (
          <p className="text-status-warn">
            Its version differs from this PC&apos;s. You can add it now and update it from its row.
          </p>
        )}
        {result.homePathMatches === false && (
          <p className="text-status-warn">
            Its home folder{result.homePath ? ` (${result.homePath})` : ''} differs from this
            PC&apos;s, so project paths will not match there.
          </p>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="own-vm-api-key">API key</Label>
          <Input
            id="own-vm-api-key"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            disabled={pending}
          />
          <p className="text-muted-foreground">
            Run <code>devchain host api-key reset</code> on the VM, then paste the key here.
          </p>
        </div>
        {fingerprintField}
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1 space-y-1.5">
            <Label htmlFor="own-vm-add-name">Name</Label>
            <Input
              id="own-vm-add-name"
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              disabled={pending}
            />
          </div>
          <Button
            type="button"
            onClick={() => onAddVm(result.baseUrl)}
            disabled={
              pending || name.trim().length === 0 || apiKey.trim().length === 0 || !fingerprintValid
            }
          >
            Add VM
          </Button>
        </div>
      </section>
    );
  }

  if (result.kind === 'installer') {
    const outcome = installerOutcome(result, openOperation);
    return (
      <section aria-label="Address check" className={panel}>
        {outcome.kind === 'ready' && (
          <>
            <p role="status">The installer is waiting at {hostPort(result.bootstrapUrl)}.</p>
            {fingerprintField}
            <Button
              type="button"
              size="sm"
              onClick={() => onSetUpInstaller(result)}
              disabled={!fingerprintValid}
            >
              Continue
            </Button>
          </>
        )}
        {(outcome.kind === 'running' || outcome.kind === 'stopped') &&
          (outcome.operation ? (
            <OpenSetupNotice operation={outcome.operation} onOpenActivity={onOpenActivity} />
          ) : (
            <p role="status">Setup is already running on this VM.</p>
          ))}
        {outcome.kind === 'unsupported' && (
          <p role="alert" className="text-destructive">
            {outcome.message}
          </p>
        )}
      </section>
    );
  }

  return (
    <section aria-label="Address check" className={panel}>
      <p role="status">{nothingSentence(result)}</p>
      {openOperation ? (
        <OpenSetupNotice operation={openOperation} onOpenActivity={onOpenActivity} />
      ) : (
        <>
          <p>Install DevChain on this VM:</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={onInstallOverSsh}>
              Install over SSH
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={onRunBlock}>
              Run the install block yourself
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
