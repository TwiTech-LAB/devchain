import { useId, type ReactNode } from 'react';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Switch } from '@/ui/components/ui/switch';
import { IdentitySummary } from './IdentitySummary';
import { providerName } from './login-choices';

function Row({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_1fr]">
      <dt id={id} className="text-muted-foreground">
        {label}
      </dt>
      <dd aria-labelledby={id} className="min-w-0 break-words">
        {children}
      </dd>
    </div>
  );
}

/** The last look before the setup starts: what runs where, with which logins. */
export function OwnVmReview({
  vm,
  how,
  logins,
  name,
  onNameChange,
  installDocker,
  onInstallDockerChange,
  freeDisk,
  hasSshPublicKey,
  disabled,
}: {
  vm: string;
  how: string;
  logins: Array<{ provider: string; label: string }>;
  name: string;
  onNameChange: (name: string) => void;
  installDocker: boolean;
  /** Absent when an earlier step already asked. */
  onInstallDockerChange?: (installDocker: boolean) => void;
  freeDisk?: string;
  hasSshPublicKey?: boolean;
  disabled: boolean;
}) {
  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-1.5">
        <Label htmlFor="own-vm-name">Name</Label>
        <Input
          id="own-vm-name"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          disabled={disabled}
        />
      </div>
      <dl className="space-y-2 rounded-md border p-3">
        <Row label="VM">{vm}</Row>
        <Row label="How">{how}</Row>
        {freeDisk && <Row label="Free disk">{freeDisk}</Row>}
        {hasSshPublicKey && <Row label="SSH key">Add the selected public key</Row>}
        <Row label="Logins">
          {logins.length === 0 ? (
            'None'
          ) : (
            <ul className="space-y-0.5">
              {logins.map((login) => (
                <li key={login.provider}>
                  {providerName(login.provider)}: {login.label}
                </li>
              ))}
            </ul>
          )}
        </Row>
        {!onInstallDockerChange && <Row label="Docker">{installDocker ? 'Install' : 'Skip'}</Row>}
      </dl>
      {onInstallDockerChange && (
        <div className="flex items-center gap-2">
          <Switch
            id="own-vm-install-docker"
            checked={installDocker}
            onCheckedChange={onInstallDockerChange}
            disabled={disabled}
          />
          <Label htmlFor="own-vm-install-docker">Install Docker</Label>
        </div>
      )}
      <IdentitySummary />
    </div>
  );
}
