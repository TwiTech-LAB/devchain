import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ProbeResultDto } from '@/modules/remotes/dtos/remote-probe.dto';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { Button } from '@/ui/components/ui/button';
import { BusyStatus, Spinner } from '@/ui/components/ui/spinner';
import { Textarea } from '@/ui/components/ui/textarea';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';
import { getErrorMessage } from '@/ui/lib/toast-helpers';
import { parseCertificateFingerprint } from '@/modules/remotes/dtos/remote.dto';
import { CertificateFingerprintField } from './CertificateFingerprintField';
import { INSTALLER_POLL_MS, hostPort, installerUrl, probeAddress } from './own-vm-address';

type InstallerResult = Extract<ProbeResultDto, { kind: 'installer' }>;

/**
 * Checks the installer's port on the address's host until `onInstaller`
 * takes an answer. Each check starts `INSTALLER_POLL_MS` after the previous
 * one answered; unmounting stops the checks.
 */
function useInstallerWatch(address: string, onInstaller: (result: InstallerResult) => boolean) {
  const latest = useRef(onInstaller);
  latest.current = onInstaller;
  const url = installerUrl(address);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const result = await probeAddress(url, { checkSsh: false, signal: controller.signal });
        if (controller.signal.aborted) return;
        if (result.kind === 'installer' && latest.current(result)) return;
      } catch {
        if (controller.signal.aborted) return;
      }
      timer = setTimeout(() => void check(), INSTALLER_POLL_MS);
    };
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [url]);
  return url;
}

/**
 * The install block to run on the VM. When the installer answers, the step
 * asks for the fingerprint the block printed; the flow goes on only with one.
 */
export function InstallBlockStep({
  address,
  minDiskGib,
  notice,
  onInstaller,
  ready,
  fingerprint,
  onFingerprintChange,
  onContinue,
}: {
  address: string;
  minDiskGib: number;
  /** Why the installer that answered cannot be set up yet, if one answered. */
  notice: ReactNode;
  /** Returns whether this installer can be set up; checks stop once it can. */
  onInstaller: (result: InstallerResult) => boolean;
  /** The installer answered and can be set up. */
  ready: boolean;
  fingerprint: string;
  onFingerprintChange: (value: string) => void;
  onContinue: () => void;
}) {
  const url = useInstallerWatch(address, onInstaller);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const block = useQuery(
    {
      queryKey: [HOME_BACKEND, 'host-install-block', minDiskGib],
      queryFn: async ({ signal }) => {
        const query = new URLSearchParams({ minDiskGib: String(minDiskGib) });
        const response = await apiFetch(
          `/api/remotes/host-install/block?${query.toString()}`,
          { signal },
          { backend: HOME_BACKEND },
        );
        const body = (await response.json().catch(() => null)) as {
          block?: unknown;
          message?: unknown;
        } | null;
        if (!response.ok) {
          throw new Error(
            typeof body?.message === 'string'
              ? body.message
              : 'Could not generate the install block.',
          );
        }
        if (typeof body?.block !== 'string' || body.block.length === 0) {
          throw new Error('The server returned an empty install block.');
        }
        return body.block;
      },
      staleTime: Infinity,
      retry: false,
    },
    useHomeQueryClient(),
  );

  const copy = async () => {
    if (!block.data) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(block.data);
      setCopyStatus('Install block copied.');
    } catch (cause) {
      setCopyStatus(getErrorMessage(cause, 'Could not copy the install block.'));
    }
  };

  return (
    <div className="space-y-3 text-sm">
      <p>
        This block installs DevChain&apos;s installer without sending SSH credentials from this PC.
        It asks for {minDiskGib} GiB of free disk.
      </p>
      {block.isPending && (
        <BusyStatus className="text-muted-foreground">Generating the install block…</BusyStatus>
      )}
      {block.error && (
        <p role="alert" className="text-destructive">
          {block.error.message}
        </p>
      )}
      {block.data && (
        <div className="space-y-2">
          <Textarea
            aria-label="Install block"
            readOnly
            value={block.data}
            rows={8}
            className="bg-muted font-mono text-xs"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
              Copy install block
            </Button>
            <span role="status" className="text-muted-foreground">
              {copyStatus}
            </span>
          </div>
        </div>
      )}
      <ol className="list-decimal space-y-1 pl-5">
        <li>Paste the block into a root shell on the VM over SSH, not a hypervisor console.</li>
        <li>Keep this dialog open until the installer answers.</li>
        <li>Paste the certificate fingerprint that the block printed.</li>
      </ol>
      <p role="status" aria-live="polite" className="text-muted-foreground">
        {url && !ready && (
          <>
            <Spinner className="mr-1" />
            {`Waiting for the installer at ${hostPort(url)}…`}
          </>
        )}
        {url && ready ? `The installer answers at ${hostPort(url)}.` : null}
      </p>
      {ready && (
        <div className="space-y-2">
          <CertificateFingerprintField
            id="own-vm-block-fingerprint"
            value={fingerprint}
            onChange={onFingerprintChange}
            fromBlock
          />
          <Button
            type="button"
            size="sm"
            onClick={onContinue}
            disabled={parseCertificateFingerprint(fingerprint) === null}
          >
            Continue
          </Button>
        </div>
      )}
      {notice}
    </div>
  );
}
