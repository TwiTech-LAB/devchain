import { useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import type { SshCredentials, LocalSshKey } from './lib/remote-vm-contracts';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Textarea } from '@/ui/components/ui/textarea';
import { useRemoteVmApi } from './lib/remote-vm-api-context';
import { IdentitySummary } from './IdentitySummary';

export interface SshCredentialDraft {
  authKind: 'password' | 'key';
  user: string;
  password: string;
  privateKey: string;
  keyName: string;
  passphrase: string;
  sudoPassword: string;
}

export const EMPTY_SSH_DRAFT: SshCredentialDraft = {
  authKind: 'password',
  user: '',
  password: '',
  privateKey: '',
  keyName: '',
  passphrase: '',
  sudoPassword: '',
};

export function toCredentials(draft: SshCredentialDraft): SshCredentials {
  const credentials: SshCredentials = { user: draft.user.trim() };
  if (draft.authKind === 'password') credentials.password = draft.password;
  else {
    if (draft.keyName) credentials.keyName = draft.keyName;
    else credentials.privateKey = draft.privateKey;
    if (draft.passphrase) credentials.passphrase = draft.passphrase;
  }
  if (draft.sudoPassword) credentials.sudoPassword = draft.sudoPassword;
  return credentials;
}

export function credentialsAreValid(draft: SshCredentialDraft): boolean {
  return (
    draft.user.trim().length > 0 &&
    (draft.authKind === 'password'
      ? draft.password.length > 0
      : draft.keyName.length > 0 || draft.privateKey.trim().length > 0)
  );
}

function updateDraft(
  setDraft: Dispatch<SetStateAction<SshCredentialDraft>>,
  key: keyof SshCredentialDraft,
  value: string,
) {
  setDraft((current) => ({ ...current, [key]: value }));
}

type SignInMethod = 'pc-key' | 'password' | 'pasted-key';

function signInMethod(draft: SshCredentialDraft): SignInMethod {
  if (draft.authKind === 'password') return 'password';
  return draft.keyName ? 'pc-key' : 'pasted-key';
}

/**
 * This PC's SSH keys, or none when this PC does not offer them (it lists
 * keys only while it binds to loopback). A key the list no longer holds is
 * dropped from the draft.
 */
function useLocalKeys(setDraft: Dispatch<SetStateAction<SshCredentialDraft>>): LocalSshKey[] {
  const api = useRemoteVmApi();
  const [keys, setKeys] = useState<LocalSshKey[]>([]);
  useEffect(() => {
    let cancelled = false;
    const keep = (available: LocalSshKey[]) => {
      if (cancelled) return;
      setKeys(available);
      setDraft((current) =>
        current.keyName && !available.some((key) => key.name === current.keyName)
          ? { ...current, keyName: '', passphrase: '' }
          : current,
      );
    };
    void (async () => {
      try {
        keep(await api.listLocalSshKeys());
      } catch {
        keep([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, setDraft]);
  return keys;
}

export function SshCredentialFields({
  draft,
  setDraft,
  idPrefix,
  disabled,
}: {
  draft: SshCredentialDraft;
  setDraft: Dispatch<SetStateAction<SshCredentialDraft>>;
  idPrefix: string;
  disabled: boolean;
}) {
  const localKeys = useLocalKeys(setDraft);
  const method = signInMethod(draft);
  const selectedKey = localKeys.find((key) => key.name === draft.keyName);
  const showPassphrase = method === 'pasted-key' || selectedKey?.encrypted === true;

  const chooseMethod = (next: SignInMethod) =>
    setDraft((current) => ({
      ...current,
      authKind: next === 'password' ? 'password' : 'key',
      password: '',
      privateKey: '',
      keyName: next === 'pc-key' ? (localKeys[0]?.name ?? '') : '',
      passphrase: '',
    }));

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-user`}>SSH user</Label>
        <Input
          id={`${idPrefix}-user`}
          value={draft.user}
          onChange={(event) => updateDraft(setDraft, 'user', event.target.value)}
          autoComplete="username"
          spellCheck={false}
          disabled={disabled}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-auth-kind`}>Sign in with</Label>
        <Select
          value={method}
          onValueChange={(value) => chooseMethod(value as SignInMethod)}
          disabled={disabled}
        >
          <SelectTrigger id={`${idPrefix}-auth-kind`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {localKeys.length > 0 && <SelectItem value="pc-key">A key from this PC</SelectItem>}
            <SelectItem value="password">Password</SelectItem>
            <SelectItem value="pasted-key">A pasted key</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {method === 'password' && (
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`${idPrefix}-password`}>SSH password</Label>
          <Input
            id={`${idPrefix}-password`}
            type="password"
            value={draft.password}
            onChange={(event) => updateDraft(setDraft, 'password', event.target.value)}
            autoComplete="current-password"
            disabled={disabled}
          />
        </div>
      )}
      {method === 'pc-key' && (
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`${idPrefix}-key-name`}>Key (the DevChain user&apos;s ~/.ssh)</Label>
          <Select
            value={draft.keyName}
            onValueChange={(keyName) => {
              const key = localKeys.find((candidate) => candidate.name === keyName);
              setDraft((current) => ({
                ...current,
                keyName,
                passphrase: key?.encrypted ? current.passphrase : '',
              }));
            }}
            disabled={disabled}
          >
            <SelectTrigger id={`${idPrefix}-key-name`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {localKeys.map((key) => (
                <SelectItem key={key.name} value={key.name}>
                  {key.name} · {key.type ?? 'unknown'}
                  {key.encrypted ? ' · passphrase' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {method === 'pasted-key' && (
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`${idPrefix}-private-key`}>Private key</Label>
          <Textarea
            id={`${idPrefix}-private-key`}
            value={draft.privateKey}
            onChange={(event) => updateDraft(setDraft, 'privateKey', event.target.value)}
            autoComplete="off"
            spellCheck={false}
            rows={5}
            disabled={disabled}
            className="font-mono text-xs"
          />
        </div>
      )}
      {showPassphrase && (
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`${idPrefix}-passphrase`}>Key passphrase (optional)</Label>
          <Input
            id={`${idPrefix}-passphrase`}
            type="password"
            value={draft.passphrase}
            onChange={(event) => updateDraft(setDraft, 'passphrase', event.target.value)}
            autoComplete="off"
            disabled={disabled}
          />
        </div>
      )}
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-sudo-password`}>Sudo password (optional)</Label>
        <Input
          id={`${idPrefix}-sudo-password`}
          type="password"
          value={draft.sudoPassword}
          onChange={(event) => updateDraft(setDraft, 'sudoPassword', event.target.value)}
          autoComplete="current-password"
          disabled={disabled}
        />
      </div>
    </div>
  );
}

export function HostInstallRetryForm({
  pending,
  onRetry,
  initialKeyName,
}: {
  pending: boolean;
  onRetry: (credentials: SshCredentials) => void;
  initialKeyName?: string;
}) {
  const [draft, setDraft] = useState<SshCredentialDraft>(() => ({
    ...EMPTY_SSH_DRAFT,
    ...(initialKeyName ? { authKind: 'key', keyName: initialKeyName } : {}),
  }));
  const valid = credentialsAreValid(draft);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const credentials = toCredentials(draft);
    onRetry(credentials);
    setDraft(EMPTY_SSH_DRAFT);
  };

  return (
    <form
      onSubmit={submit}
      aria-label="SSH credentials retry"
      className="space-y-3 rounded-md border border-status-warn/50 bg-status-warn/5 p-3 text-sm"
    >
      <p className="font-medium">SSH credentials required</p>
      <p>Enter the credentials again to retry this host installation.</p>
      <IdentitySummary />
      <SshCredentialFields
        draft={draft}
        setDraft={setDraft}
        idPrefix="retry-ssh"
        disabled={pending}
      />
      <Button type="submit" size="sm" disabled={!valid} pending={pending}>
        {pending ? 'Retrying…' : 'Retry'}
      </Button>
    </form>
  );
}
