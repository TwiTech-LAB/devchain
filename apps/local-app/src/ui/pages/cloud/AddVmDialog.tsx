import { useCallback, useMemo, useState } from 'react';
import { isProxmoxDnsName } from '@/common/validation/proxmox-name';
import { MIN_VM_MEMORY_MIB } from '@/modules/remotes/operations/vm-operations.dto';
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
import { cn } from '@/ui/lib/utils';
import { IdentitySummary, isClaimableIdentity } from './IdentitySummary';
import {
  LOGIN_PROVIDERS,
  choiceLabel,
  defaultLoginChoice,
  providerName,
  setupProviderAuth,
} from './login-choices';
import { SetupLoginStep, useAddLoginLink, useLoginChoices } from './LoginChoiceStep';
import { StartError } from './StartError';
import { SshPublicKeyField, sshPublicKeysBody, validSshPublicKeyDraft } from './SshPublicKeyField';

export interface CreateVmRequest {
  name: string;
  cores: number;
  memory: number;
  disk: number;
  providerAuth: Record<string, string>;
  installDocker?: boolean;
  sshPublicKeys?: string[];
}

const PRESETS = {
  small: { label: 'Small', cores: 2, memory: 4096, disk: 30 },
  medium: { label: 'Medium', cores: 4, memory: 8192, disk: 60 },
  large: { label: 'Large', cores: 8, memory: 16384, disk: 120 },
} as const;
type PresetKey = keyof typeof PRESETS | 'custom';

type Step = 'details' | 'logins' | 'review';
const STEPS: Step[] = ['details', 'logins', 'review'];
const STEP_LABELS: Record<Step, string> = {
  details: 'Details',
  logins: 'Logins',
  review: 'Review',
};

function sizeText(size: { cores: number; memory: number; disk: number }): string {
  const memory = size.memory % 1024 === 0 ? `${size.memory / 1024} GiB` : `${size.memory} MiB`;
  return `${size.cores} vCPU · ${memory} memory · ${size.disk} GiB disk`;
}

const PRESET_KEYS: PresetKey[] = [
  ...(Object.keys(PRESETS) as Array<keyof typeof PRESETS>),
  'custom',
];

function presetText(key: PresetKey): { label: string; detail: string } {
  if (key === 'custom') return { label: 'Custom', detail: 'Choose each value' };
  return { label: PRESETS[key].label, detail: sizeText(PRESETS[key]) };
}

function NumberField({
  id,
  label,
  value,
  min,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  min: number;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={min}
        step={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
    </div>
  );
}

/**
 * Creates a VM on one Proxmox server and sets it up: its name and size, its
 * logins, then a review of everything DevChain will do.
 */
export function AddVmDialog({
  connectionName,
  namePrefix,
  remoteNames,
  pending,
  error,
  onClose,
  onCreate,
}: {
  connectionName: string;
  namePrefix: string;
  remoteNames: ReadonlyMap<string, string>;
  pending: boolean;
  /** The refusal of the last start request, shown on Review. */
  error?: string | null;
  onClose: () => void;
  onCreate: (body: CreateVmRequest) => void;
}) {
  const { entries } = useProviderAuth();
  const identity = useHomeIdentity();
  const [step, setStep] = useState<Step>('details');
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<PresetKey>('small');
  const [cores, setCores] = useState(String(PRESETS.small.cores));
  const [memory, setMemory] = useState(String(PRESETS.small.memory));
  const [disk, setDisk] = useState(String(PRESETS.small.disk));
  const [installDocker, setInstallDocker] = useState(true);
  const [sshPublicKey, setSshPublicKey] = useState('');

  // The VM does not exist yet, so every login another VM holds is refused.
  const context = useMemo(() => ({ targetRemoteId: null, remoteNames }), [remoteNames]);
  const defaultFor = useCallback(
    (provider: string) => defaultLoginChoice(provider, entries, context),
    [entries, context],
  );
  const { choices, setChoice } = useLoginChoices(LOGIN_PROVIDERS, defaultFor);
  const { onAddLogin, addLoginDialog } = useAddLoginLink(LOGIN_PROVIDERS, setChoice);

  const trimmed = name.trim();
  const validName =
    trimmed.length > 0 && trimmed.length <= 100 && isProxmoxDnsName(`${namePrefix}${trimmed}`);
  const size =
    preset === 'custom'
      ? { cores: Number(cores), memory: Number(memory), disk: Number(disk) }
      : PRESETS[preset];
  const validCores = Number.isInteger(size.cores) && size.cores >= 1;
  const validMemory = Number.isInteger(size.memory) && size.memory >= MIN_VM_MEMORY_MIB;
  const validDisk = Number.isInteger(size.disk) && size.disk >= 1;
  const detailsValid = validName && validCores && validMemory && validDisk;
  const keyValid = validSshPublicKeyDraft(sshPublicKey);
  const canCreate = !pending && detailsValid && keyValid && isClaimableIdentity(identity);

  const providerAuth = setupProviderAuth(choices);
  const loginLines = Object.entries(providerAuth).map(
    ([provider, choice]) =>
      `${providerName(provider)}: ${choiceLabel(provider, choice, entries, context)}`,
  );

  const create = () => {
    if (!canCreate) return;
    onCreate({
      name: trimmed,
      cores: size.cores,
      memory: size.memory,
      disk: size.disk,
      providerAuth,
      ...sshPublicKeysBody(sshPublicKey),
      ...(installDocker ? { installDocker: true } : {}),
    });
  };

  const stepIndex = STEPS.indexOf(step);

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] overflow-y-auto sm:w-full sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a VM on {connectionName}</DialogTitle>
          <DialogDescription>
            Step {stepIndex + 1} of {STEPS.length}: {STEP_LABELS[step]}
          </DialogDescription>
        </DialogHeader>

        {step === 'details' && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="add-vm-name">Name</Label>
              <Input
                id="add-vm-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="workstation"
                autoComplete="off"
                disabled={pending}
                aria-invalid={name.length > 0 && !validName}
              />
              <p className="text-xs text-muted-foreground">
                Proxmox name: {namePrefix}
                {trimmed || '…'}
              </p>
              {!validName && name.length > 0 && (
                <p role="alert" className="text-sm text-destructive">
                  Use up to 100 letters, digits, dots or hyphens. Each dot-separated part must start
                  and end with a letter or digit.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Size</p>
              <div role="group" aria-label="Size" className="grid gap-2 sm:grid-cols-2">
                {PRESET_KEYS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={preset === key}
                    disabled={pending}
                    onClick={() => setPreset(key)}
                    className={cn(
                      'rounded-md border px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      preset === key ? 'border-primary bg-primary/10' : 'hover:bg-muted/50',
                    )}
                  >
                    <span className="block font-medium">{presetText(key).label}</span>
                    <span className="block text-muted-foreground">{presetText(key).detail}</span>
                  </button>
                ))}
              </div>
            </div>
            {preset === 'custom' && (
              <div className="space-y-2">
                <div className="grid gap-3 sm:grid-cols-3">
                  <NumberField
                    id="add-vm-cores"
                    label="Cores"
                    value={cores}
                    min={1}
                    onChange={setCores}
                    disabled={pending}
                  />
                  <NumberField
                    id="add-vm-memory"
                    label="Memory (MiB)"
                    value={memory}
                    min={MIN_VM_MEMORY_MIB}
                    onChange={setMemory}
                    disabled={pending}
                  />
                  <NumberField
                    id="add-vm-disk"
                    label="Disk (GiB)"
                    value={disk}
                    min={1}
                    onChange={setDisk}
                    disabled={pending}
                  />
                </div>
                {!validCores && (
                  <p role="alert" className="text-sm text-destructive">
                    Cores must be a positive whole number.
                  </p>
                )}
                {!validMemory && (
                  <p role="alert" className="text-sm text-destructive">
                    Memory must be at least {MIN_VM_MEMORY_MIB} MiB.
                  </p>
                )}
                {!validDisk && (
                  <p role="alert" className="text-sm text-destructive">
                    Disk must be at least 1 GiB.
                  </p>
                )}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Switch
                id="add-vm-docker"
                checked={installDocker}
                onCheckedChange={setInstallDocker}
                disabled={pending}
              />
              <Label htmlFor="add-vm-docker">Install Docker</Label>
            </div>
          </div>
        )}

        {step === 'logins' && (
          <div className="space-y-2">
            <SetupLoginStep
              entries={entries}
              context={context}
              choices={choices}
              onChange={setChoice}
              onAddLogin={onAddLogin}
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

        {step === 'review' && (
          <div className="space-y-4 text-sm">
            <section aria-label="What DevChain will do" className="space-y-1">
              <h3 className="font-medium">What DevChain will do</h3>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Create {namePrefix}
                  {trimmed} on {connectionName}: {sizeText(size)}.
                </li>
                <li>Install this PC&apos;s DevChain version and set it up with your account.</li>
                <li>{installDocker ? 'Install Docker.' : 'Leave Docker out.'}</li>
                {sshPublicKey.trim() && <li>Add your SSH public key for {identity?.user}.</li>}
                <li>
                  {loginLines.length === 0
                    ? 'Place no provider logins.'
                    : `Place these logins: ${loginLines.join('; ')}.`}
                </li>
              </ul>
            </section>
            <IdentitySummary />
          </div>
        )}

        <StartError error={step === 'review' ? error : null} />
        {addLoginDialog}
        <DialogFooter>
          {step === 'details' ? (
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => setStep(STEPS[stepIndex - 1])}
              disabled={pending}
            >
              Back
            </Button>
          )}
          {step !== 'review' ? (
            <Button
              type="button"
              onClick={() => setStep(STEPS[stepIndex + 1])}
              disabled={pending || !detailsValid || (step === 'logins' && !keyValid)}
            >
              Next
            </Button>
          ) : (
            <Button
              type="button"
              onClick={create}
              disabled={!canCreate}
              pending={pending}
              data-testid="add-vm-submit"
            >
              {pending ? 'Starting…' : 'Create VM'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
