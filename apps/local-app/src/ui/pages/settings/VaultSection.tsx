import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { KeyRound, Lock, ShieldAlert } from 'lucide-react';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { Button } from '@/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { StatusChip } from '@/ui/pages/cloud/StatusChip';
import { SessionApiError } from '@/ui/lib/http-json';
import type { StatusTone } from '@/ui/lib/status-tone';
import { getErrorMessage } from '@/ui/lib/toast-helpers';
import {
  confirmVaultRecoveryCode,
  setupVault,
  unlockVault,
  vaultStatusQueryKey,
  type VaultSetupMode,
  type VaultState,
  type VaultStatus,
  type VaultVmCacheStatus,
} from '@/ui/lib/vault';
import { useVaultStatus } from '@/ui/pages/vault/useVaultQueries';

const FILE_WARNING = 'Protection: file — a copy of ~/.devchain can decrypt the Vault';
const LINGER_HINT = 'Enable linger (loginctl enable-linger) to keep runtime files in memory';
const WRONG_CODE = 'The recovery code is not correct.';

const STATE_CHIPS: Record<VaultState, { label: string; tone: StatusTone }> = {
  not_set_up: { label: 'Not set up', tone: 'neutral' },
  unlocking: { label: 'Unlocking', tone: 'running' },
  locked: { label: 'Locked', tone: 'warn' },
  unlocked: { label: 'Unlocked', tone: 'ok' },
};

export function VaultSection() {
  const queryClient = useHomeQueryClient();
  const query = useVaultStatus();

  // Write responses carry no runtime field and drop `recoveryCode` once confirmed.
  const applyStatus = (next: VaultStatus) => {
    queryClient.setQueryData<VaultStatus>(vaultStatusQueryKey, (previous) => ({
      ...next,
      runtime: next.runtime ?? previous?.runtime,
    }));
  };

  if (query.isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading Vault status…
      </p>
    );
  }

  if (query.error || !query.data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Vault unavailable</AlertTitle>
        <AlertDescription>
          {getErrorMessage(query.error, 'Vault status could not be loaded.')}
        </AlertDescription>
      </Alert>
    );
  }

  const status = query.data;

  if (status.reason === 'claimed_host') {
    return (
      <Alert variant="info">
        <KeyRound className="h-4 w-4" />
        <AlertTitle>Vault managed by home</AlertTitle>
        <AlertDescription>
          <p>This machine is a claimed VM. Its home DevChain owns the Vault.</p>
          {status.vmCache ? <p>{vmCacheText(status.vmCache)}</p> : null}
        </AlertDescription>
      </Alert>
    );
  }

  const chip = STATE_CHIPS[status.state];

  return (
    <div className="space-y-6">
      {status.recoveryCode ? (
        <RecoveryCodeBanner code={status.recoveryCode} onConfirmed={applyStatus} />
      ) : null}
      {status.state === 'locked' ? <UnlockForm onUnlocked={applyStatus} /> : null}

      <Card>
        <CardHeader>
          <CardTitle>Vault</CardTitle>
          <CardDescription>
            Encrypted secrets that DevChain gives to agents when a session starts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip tone={chip.tone}>{chip.label}</StatusChip>
            {status.protection ? (
              <StatusChip tone={status.protection === 'file' ? 'warn' : 'info'}>
                {`Protection: ${status.protection}`}
              </StatusChip>
            ) : null}
            {status.runtime ? (
              <StatusChip tone={status.runtime.protection === 'memory' ? 'ok' : 'warn'}>
                {`Runtime files: ${status.runtime.protection}`}
              </StatusChip>
            ) : null}
          </div>
          {status.protection === 'file' ? (
            <p className="text-sm text-status-warn">{FILE_WARNING}</p>
          ) : null}
          {status.runtime?.lingerHint ? (
            <p className="text-sm text-muted-foreground">{LINGER_HINT}</p>
          ) : null}
          {status.state === 'not_set_up' ? <SetupChoice onSetUp={applyStatus} /> : null}
        </CardContent>
      </Card>
    </div>
  );
}

function RecoveryCodeBanner({
  code,
  onConfirmed,
}: {
  code: string;
  onConfirmed: (status: VaultStatus) => void;
}) {
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const confirm = useMutation({
    mutationFn: () => confirmVaultRecoveryCode(),
    onSuccess: onConfirmed,
  });

  const handleCopy = async () => {
    setCopyError(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopyError('Copy failed. Select the code and copy it by hand.');
    }
  };

  return (
    <Alert variant="warn">
      <ShieldAlert className="h-4 w-4" />
      <AlertTitle>Save your Vault recovery code</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>
          You need this code to unlock the Vault when the OS credential store cannot. DevChain shows
          it only until you confirm.
        </p>
        <code
          aria-label="Recovery code"
          className="block select-all break-all rounded border bg-background px-3 py-2 font-mono text-sm text-foreground"
        >
          {code}
        </code>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => confirm.mutate()}
            disabled={confirm.isPending}
          >
            I saved it
          </Button>
        </div>
        {copyError ? <p className="text-destructive">{copyError}</p> : null}
        {confirm.error ? (
          <p className="text-destructive">
            {getErrorMessage(confirm.error, 'The confirmation was not saved.')}
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function UnlockForm({ onUnlocked }: { onUnlocked: (status: VaultStatus) => void }) {
  const [code, setCode] = useState('');
  const unlock = useMutation({
    mutationFn: (recoveryCode: string) => unlockVault(recoveryCode),
    onSuccess: (status) => {
      setCode('');
      onUnlocked(status);
    },
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = code.trim();
    if (trimmed) unlock.mutate(trimmed);
  };

  return (
    <Alert variant="warn">
      <Lock className="h-4 w-4" />
      <AlertTitle>The Vault is locked</AlertTitle>
      <AlertDescription>
        <p className="mb-3">
          Agents with Vault grants cannot start until you unlock it with the recovery code.
        </p>
        <form onSubmit={handleSubmit} className="space-y-2" autoComplete="off">
          <Label htmlFor="vault-recovery-code" className="text-foreground">
            Unlock with recovery code
          </Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="vault-recovery-code"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className="max-w-md font-mono"
            />
            <Button type="submit" disabled={unlock.isPending || code.trim() === ''}>
              Unlock
            </Button>
          </div>
          {unlock.error ? (
            <p role="alert" className="text-sm text-destructive">
              {unlockErrorMessage(unlock.error)}
            </p>
          ) : null}
        </form>
      </AlertDescription>
    </Alert>
  );
}

function vmCacheText(cache: VaultVmCacheStatus): string {
  if (cache.cacheUnavailable) {
    return 'This VM cannot keep Vault values in memory. Run Update VM from home.';
  }
  return cache.cacheReady
    ? 'Home sent the values. Agents with entries can start.'
    : 'The values are not on this VM. Agents with entries cannot start until home connects.';
}

function unlockErrorMessage(error: unknown): string {
  if (error instanceof SessionApiError && error.status === 400) return WRONG_CODE;
  return getErrorMessage(error, 'The Vault could not be unlocked.');
}

function SetupChoice({ onSetUp }: { onSetUp: (status: VaultStatus) => void }) {
  const setup = useMutation({
    mutationFn: (mode: VaultSetupMode) => setupVault(mode),
    onSuccess: onSetUp,
  });
  const choose = (mode: VaultSetupMode) => setup.mutate(mode);

  return (
    <section aria-labelledby="vault-setup-heading" className="space-y-3">
      <h3 id="vault-setup-heading" className="text-sm font-semibold">
        Set up the Vault
      </h3>
      <p className="text-sm text-muted-foreground">
        No OS credential store is available, so choose how DevChain protects the Vault key.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">Recovery code at each start</p>
          <p className="text-sm text-muted-foreground">
            The Vault stays locked after each start until you enter the recovery code.
          </p>
          <Button type="button" onClick={() => choose('recovery')} disabled={setup.isPending}>
            Use recovery code
          </Button>
        </div>
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">Key file</p>
          <p className="text-sm text-status-warn">{FILE_WARNING}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => choose('file')}
            disabled={setup.isPending}
          >
            Use key file
          </Button>
        </div>
      </div>
      {setup.error ? (
        <p role="alert" className="text-sm text-destructive">
          {getErrorMessage(setup.error, 'The Vault could not be set up.')}
        </p>
      ) : null}
    </section>
  );
}
