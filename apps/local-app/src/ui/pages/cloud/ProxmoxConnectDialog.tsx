import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { Button } from '@/ui/components/ui/button';
import { Checkbox } from '@/ui/components/ui/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/components/ui/collapsible';
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
import { Textarea } from '@/ui/components/ui/textarea';
import { useRemoteVmApi } from './lib/remote-vm-api-context';
import { vmProviderConnectionQueryKey } from './lib/remote-vm-query-keys';
import type {
  ProxmoxConnectedResult,
  ProxmoxFingerprintPreview,
  ProxmoxSetupBlockFields,
  VmProviderConnectionView,
} from './lib/remote-vm-contracts';

type Step = 'block' | 'string' | 'confirm';
const STEPS: Step[] = ['block', 'string', 'confirm'];
const STEP_LABELS: Record<Step, string> = {
  block: 'Run the setup block',
  string: 'Paste the connection string',
  confirm: 'Confirm the fingerprint',
};

/**
 * Connects a Proxmox server in three steps: the setup block for the node's
 * root shell, the connection string it prints, and the TLS fingerprint. The
 * end shows the rights result and Add VM.
 */
export function ProxmoxConnectDialog({
  onClose,
  onAddVm,
}: {
  onClose: () => void;
  onAddVm: (connection: VmProviderConnectionView) => void;
}) {
  const api = useRemoteVmApi();
  const [step, setStep] = useState<Step>('block');
  const queryClient = useHomeQueryClient();
  const [fields, setFields] = useState<ProxmoxSetupBlockFields>({
    node: '',
    address: '',
    pool: 'devchain',
    storage: '',
    imageStorage: '',
    bridge: '',
  });
  const [block, setBlock] = useState('');
  const [connectionString, setConnectionString] = useState('');
  const [preview, setPreview] = useState<ProxmoxFingerprintPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [connected, setConnected] = useState<ProxmoxConnectedResult | null>(null);
  const [pending, setPending] = useState<'block' | 'preview' | 'connect' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState('');

  const updateField = (key: keyof ProxmoxSetupBlockFields, value: string) => {
    setFields((current) => ({ ...current, [key]: value }));
    setBlock('');
    setError(null);
  };

  const generateBlock = async () => {
    setPending('block');
    setError(null);
    setCopyStatus('');
    try {
      setBlock(await api.readProxmoxSetupBlock(fields));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not generate the setup block.');
    } finally {
      setPending(null);
    }
  };

  const copyBlock = async () => {
    setError(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(block);
      setCopyStatus('Setup block copied.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not copy the setup block.');
    }
  };

  const reviewFingerprint = async () => {
    setPending('preview');
    setError(null);
    setConnected(null);
    setConfirmed(false);
    try {
      const result = await api.previewProxmoxConnection(connectionString);
      setPreview(result);
      setStep('confirm');
    } catch (cause) {
      setPreview(null);
      setError(cause instanceof Error ? cause.message : 'Could not read the connection string.');
    } finally {
      setPending(null);
    }
  };

  const connect = async () => {
    if (!preview || !confirmed) return;
    setPending('connect');
    setError(null);
    try {
      const result = await api.connectProxmox(connectionString);
      setConnected(result);
      setConnectionString('');
      setPreview(null);
      setConfirmed(false);
      await queryClient.invalidateQueries({ queryKey: vmProviderConnectionQueryKey });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not connect Proxmox.');
    } finally {
      setPending(null);
    }
  };

  const updateConnectionString = (value: string) => {
    setConnectionString(value);
    setPreview(null);
    setConfirmed(false);
    setConnected(null);
    setError(null);
  };

  const stepIndex = STEPS.indexOf(step);

  return (
    <Dialog open onOpenChange={(open) => !open && pending === null && onClose()}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] overflow-y-auto sm:w-full sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Connect a server</DialogTitle>
          <DialogDescription>
            Step {stepIndex + 1} of {STEPS.length}: {STEP_LABELS[step]}
          </DialogDescription>
        </DialogHeader>

        {step === 'block' && (
          <section aria-label="Proxmox setup block" className="space-y-3">
            <p className="text-sm">
              Generate the setup block and paste it into the Proxmox node&apos;s root shell. It
              creates DevChain&apos;s pool, role and API token, and prints a connection string.
            </p>
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="outline" className="group w-full justify-between">
                  Advanced (optional)
                  <ChevronDown
                    className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180"
                    aria-hidden="true"
                  />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 pt-3">
                <p className="text-xs text-muted-foreground">
                  Leave these empty. The setup block finds the values on the node and prints what it
                  chose.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {(
                    [
                      ['node', 'Node'],
                      ['address', 'Proxmox address'],
                      ['pool', 'Pool'],
                      ['storage', 'VM storage'],
                      ['imageStorage', 'Image storage'],
                      ['bridge', 'Network bridge'],
                    ] as const
                  ).map(([key, label]) => (
                    <div key={key} className="space-y-1.5">
                      <Label htmlFor={`proxmox-${key}`}>{label}</Label>
                      <Input
                        id={`proxmox-${key}`}
                        value={fields[key]}
                        onChange={(event) => updateField(key, event.target.value)}
                        disabled={pending !== null}
                      />
                      {key === 'address' && (
                        <p className="text-xs text-muted-foreground">
                          Use the address you open the Proxmox web UI with.
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
            <Button
              type="button"
              variant="outline"
              onClick={generateBlock}
              disabled={pending !== null}
              pending={pending === 'block'}
            >
              {pending === 'block' ? 'Generating…' : 'Generate setup block'}
            </Button>
            {block && (
              <div className="space-y-2">
                <Textarea
                  aria-label="Generated setup block"
                  readOnly
                  value={block}
                  rows={9}
                  className="bg-muted font-mono text-xs"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={copyBlock}
                    disabled={pending !== null}
                  >
                    Copy setup block
                  </Button>
                  {copyStatus && (
                    <span role="status" className="text-sm text-muted-foreground">
                      {copyStatus}
                    </span>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {step === 'string' && (
          <section aria-label="Proxmox connection string" className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="proxmox-connection-string">Connection string</Label>
              <Textarea
                id="proxmox-connection-string"
                value={connectionString}
                onChange={(event) => updateConnectionString(event.target.value)}
                rows={3}
                autoComplete="off"
                spellCheck={false}
                disabled={pending !== null}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                The string contains the one-time token secret. It is sent for this request and
                cleared after connection.
              </p>
            </div>
          </section>
        )}

        {step === 'confirm' && preview && !connected && (
          <section aria-label="Proxmox fingerprint" className="space-y-3 text-sm">
            <p>Confirm this Proxmox TLS fingerprint before connecting:</p>
            <p className="break-all font-mono" data-testid="proxmox-fingerprint">
              {preview.fingerprint}
            </p>
            <dl
              className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]"
              data-testid="proxmox-placement"
            >
              <dt className="text-muted-foreground">Node</dt>
              <dd className="break-all font-mono">{preview.placement.node}</dd>
              <dt className="text-muted-foreground">VM storage</dt>
              <dd className="break-all font-mono">{preview.placement.storage}</dd>
              <dt className="text-muted-foreground">Image storage</dt>
              <dd className="break-all font-mono">{preview.placement.imageStorage}</dd>
              <dt className="text-muted-foreground">Network bridge</dt>
              <dd className="break-all font-mono">{preview.placement.bridge}</dd>
              <dt className="text-muted-foreground">Pool</dt>
              <dd className="break-all font-mono">{preview.placement.pool}</dd>
              <dt className="text-muted-foreground">API address</dt>
              <dd className="break-all font-mono">{preview.placement.apiUrl}</dd>
            </dl>
            <div className="flex items-start gap-2">
              <Checkbox
                id="proxmox-confirm-fingerprint"
                checked={confirmed}
                onCheckedChange={(checked) => setConfirmed(checked === true)}
                disabled={pending !== null}
                aria-label="Confirm Proxmox fingerprint"
                className="mt-0.5"
              />
              <Label htmlFor="proxmox-confirm-fingerprint" className="font-normal">
                I verified this fingerprint against the Proxmox node.
              </Label>
            </div>
          </section>
        )}

        {connected && (
          <section aria-label="Connection result" className="space-y-2 text-sm">
            <p role="status" className="font-medium">
              Connected to {connected.connection.name}.
            </p>
            {connected.permissions.missing.length === 0 ? (
              <p className="text-status-ok">All required Proxmox rights are present.</p>
            ) : (
              <div role="alert" className="space-y-1">
                <p className="font-medium text-destructive">Missing Proxmox rights:</p>
                <ul aria-label="Missing Proxmox rights" className="list-disc pl-5">
                  {connected.permissions.missing.map((right) => (
                    <li key={right}>{right}</li>
                  ))}
                </ul>
                <p>
                  Fix: re-run the setup block on the Proxmox node, then use Check again on its
                  server box.
                </p>
              </div>
            )}
          </section>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          {connected ? (
            <>
              <Button type="button" variant="outline" onClick={onClose}>
                Done
              </Button>
              <Button type="button" onClick={() => onAddVm(connected.connection)}>
                Add VM
              </Button>
            </>
          ) : (
            <>
              {step === 'block' ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={onClose}
                  disabled={pending !== null}
                >
                  Close
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setError(null);
                    setStep(STEPS[stepIndex - 1]);
                  }}
                  disabled={pending !== null}
                >
                  Back
                </Button>
              )}
              {step === 'block' && (
                <Button type="button" onClick={() => setStep('string')}>
                  Next
                </Button>
              )}
              {step === 'string' && (
                <Button
                  type="button"
                  onClick={reviewFingerprint}
                  disabled={!connectionString.trim() || pending !== null}
                  pending={pending === 'preview'}
                >
                  {pending === 'preview' ? 'Checking…' : 'Review fingerprint'}
                </Button>
              )}
              {step === 'confirm' && (
                <Button
                  type="button"
                  onClick={connect}
                  disabled={!preview || !confirmed || pending !== null}
                  pending={pending === 'connect'}
                >
                  {pending === 'connect' ? 'Connecting…' : 'Connect'}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
