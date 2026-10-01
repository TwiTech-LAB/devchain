import {
  CERTIFICATE_FINGERPRINT_MESSAGE,
  parseCertificateFingerprint,
} from '@/modules/remotes/dtos/remote.dto';
import { HOST_CERTIFICATE_FINGERPRINT_COMMAND } from '@/modules/remotes/host-install/host-install-block';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';

/**
 * Asks for the VM certificate's fingerprint as read on the VM. This PC shows
 * no fingerprint of its own: one read over the unverified connection proves
 * nothing, so the value must come from the VM.
 */
export function CertificateFingerprintField({
  id,
  value,
  onChange,
  disabled,
  fromBlock = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** The install block printed the fingerprint, so the hint names it first. */
  fromBlock?: boolean;
}) {
  const invalid = value.trim() !== '' && parseCertificateFingerprint(value) === null;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Certificate fingerprint (SHA-256)</Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="AB:CD:EF:…"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={invalid}
        aria-describedby={`${id}-hint`}
        className="font-mono"
        disabled={disabled}
      />
      <p id={`${id}-hint`} className="text-muted-foreground">
        {fromBlock ? 'The install block printed it after the address. ' : ''}
        To print it on the VM (console or SSH), run{' '}
        <code className="break-all">{HOST_CERTIFICATE_FINGERPRINT_COMMAND}</code>. This PC sends
        nothing to the VM until the fingerprint matches.
      </p>
      {invalid && (
        <p role="alert" className="text-destructive">
          {CERTIFICATE_FINGERPRINT_MESSAGE}
        </p>
      )}
    </div>
  );
}
