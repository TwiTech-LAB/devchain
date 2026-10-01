import { useEffect, useState } from 'react';
import { parseSshPublicKey, SSH_PUBLIC_KEY_MESSAGE } from '@/common/validation/ssh-public-key';
import { Label } from '@/ui/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Textarea } from '@/ui/components/ui/textarea';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';
import type { AvailableSshPublicKey } from '@/modules/remotes/host-install/ssh-key.service';

export function validSshPublicKeyDraft(value: string): boolean {
  return value.trim() === '' || parseSshPublicKey(value.trim()) !== null;
}

/** The request field for a key draft: the trimmed key, or nothing for an empty draft. */
export function sshPublicKeysBody(draft: string): { sshPublicKeys?: string[] } {
  const key = draft.trim();
  return key ? { sshPublicKeys: [key] } : {};
}

export function SshPublicKeyField({
  user,
  value,
  onChange,
  disabled,
}: {
  user?: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const [keys, setKeys] = useState<AvailableSshPublicKey[]>([]);
  const [selection, setSelection] = useState('none');
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await apiFetch(
          '/api/remotes/host-install/ssh-public-keys',
          { signal: controller.signal },
          { backend: HOME_BACKEND },
        );
        const result = response.ok
          ? ((await response.json()) as { available?: boolean; keys?: AvailableSshPublicKey[] })
          : null;
        if (!controller.signal.aborted)
          setKeys(result?.available === true && Array.isArray(result.keys) ? result.keys : []);
      } catch {
        if (!controller.signal.aborted) setKeys([]);
      }
    })();
    return () => controller.abort();
  }, []);

  const selected = keys.find((key) => key.content === value);
  const method = selected ? selected.name : value ? 'paste' : selection;
  const valid = validSshPublicKeyDraft(value);
  return (
    <div className="space-y-2">
      <Label htmlFor="setup-ssh-public-key">SSH key for {user ?? 'your account'} (optional)</Label>
      <Select
        value={method}
        disabled={disabled}
        onValueChange={(next) => {
          setSelection(next);
          onChange(keys.find((key) => key.name === next)?.content ?? '');
        }}
      >
        <SelectTrigger id="setup-ssh-public-key">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No SSH key</SelectItem>
          {keys.map((key) => (
            <SelectItem key={key.name} value={key.name}>
              {key.name} · {key.type}
            </SelectItem>
          ))}
          <SelectItem value="paste">Paste a public key</SelectItem>
        </SelectContent>
      </Select>
      {method === 'paste' && (
        <>
          <Label htmlFor="setup-ssh-public-key-paste">SSH public key</Label>
          <Textarea
            id="setup-ssh-public-key-paste"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
            spellCheck={false}
            rows={3}
            placeholder="ssh-ed25519 AAAA…"
            aria-invalid={!valid}
            className="font-mono text-xs"
          />
        </>
      )}
      {selected && (
        <p className="break-all text-xs text-muted-foreground">
          {selected.fingerprint}
          {selected.comment ? ` · ${selected.comment}` : ''}
        </p>
      )}
      {!valid && (
        <p role="alert" className="text-sm text-destructive">
          {SSH_PUBLIC_KEY_MESSAGE}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Adds this public key to your VM account so you can SSH in. Existing keys are kept.
      </p>
    </div>
  );
}
