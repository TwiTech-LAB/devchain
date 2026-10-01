import { Loader2, RefreshCw } from 'lucide-react';
import {
  PROVIDER_CLI_NAMES,
  type ProviderCliInstallStatus,
  type ProviderCliName,
} from '@devchain/shared';
import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import { Button } from '@/ui/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Switch } from '@/ui/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/components/ui/table';
import { getErrorMessage, useToastHelpers } from '@/ui/lib/toast-helpers';
import { useProviderClis } from '@/ui/hooks/useProviderClis';
import { useRemotes } from '@/ui/hooks/useRemotes';
import { providerName } from '@/ui/pages/cloud/login-choices';

const LATEST = 'latest';

type PcTone = 'muted' | 'busy' | 'error' | 'ok';

const PC_TONE_CLASSES: Record<PcTone, string> = {
  muted: 'text-xs text-muted-foreground',
  busy: 'text-xs',
  error: 'text-xs text-destructive',
  ok: 'text-xs',
};

/**
 * A VM's CLI state as home sees it. `providerClis` is the managed-providers
 * report (partial: only providers the VM reported); `cliVersions` carries the
 * claim-time versions, the only source for Antigravity.
 */
interface RemoteCliView {
  id: string;
  name: string;
  online: boolean;
  providerClis: RemoteListItemDto['providerClis'];
  cliVersions: RemoteListItemDto['cliVersions'];
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString();
}

function thisPcStatus(
  install: ProviderCliInstallStatus | null,
  homeManaged: boolean,
): { text: string; tone: PcTone } {
  // The API always reports an install status; only the setting decides whose
  // install runs. An opted-out provider keeps its last managed status in that
  // report, which must not be shown as the active version.
  if (!homeManaged) {
    return { text: 'Your own install', tone: 'muted' };
  }
  if (install?.state === 'installing') {
    return { text: `Installing ${install.desiredVersion}…`, tone: 'busy' };
  }
  if (install?.state === 'failed') {
    return { text: `Failed: ${install.error ?? 'install error'}`, tone: 'error' };
  }
  if (!install || install.installedVersion === null) {
    return { text: 'Not installed yet', tone: 'muted' };
  }
  return { text: install.installedVersion, tone: 'ok' };
}

function VmCliCell({ remote, provider }: { remote: RemoteCliView; provider: ProviderCliName }) {
  const entry = remote.providerClis?.[provider];
  if (!entry) {
    return <span className="text-xs text-muted-foreground">No report yet</span>;
  }
  const stale = !remote.online;
  return (
    <span className="flex flex-col gap-0.5">
      <span
        className={stale ? 'text-xs text-muted-foreground' : 'text-xs'}
        title={stale ? 'Offline — last known version' : undefined}
      >
        {entry.installedVersion ?? '—'}
        {stale && ' (stale)'}
      </span>
      {entry.state === 'installing' && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Installing
        </span>
      )}
      {entry.state === 'failed' && entry.error && (
        <span className="text-xs text-destructive" title={entry.error}>
          Failed
        </span>
      )}
    </span>
  );
}

/**
 * The "CLI versions" section of /providers: one row per managed provider plus
 * a read-only Antigravity row, the This-PC status, and one column per VM.
 * All reads and writes go to home.
 */
export function ProviderCliVersionsSection() {
  const { overviewQuery, overview, setEntryMutation, checkNowMutation } = useProviderClis();
  const { showError } = useToastHelpers();
  const { remotes } = useRemotes();

  const remotesView: RemoteCliView[] = remotes.map((remote) => ({
    id: remote.id,
    name: remote.name,
    online: remote.online,
    providerClis: remote.providerClis,
    cliVersions: remote.cliVersions,
  }));

  const handleSave = (
    provider: ProviderCliName,
    entry: { version: string; homeManaged: boolean },
  ) =>
    setEntryMutation.mutate(
      { provider, entry },
      {
        onError: (error) =>
          showError({
            title: 'Save failed',
            description: getErrorMessage(error, `Failed to save ${provider} version.`),
          }),
      },
    );

  const overviewProviders = overview?.providers;

  return (
    <section aria-label="CLI versions">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">CLI versions</h2>
          <p className="text-sm text-muted-foreground">
            Pick Latest or a pinned version per provider, and let DevChain manage the install on
            this PC. Settings apply to this PC and every VM.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            checkNowMutation.mutate(undefined, {
              onError: (error) =>
                showError({
                  title: 'Check failed',
                  description: getErrorMessage(error, 'Failed to check for new releases.'),
                }),
            })
          }
          disabled={checkNowMutation.isPending}
        >
          {checkNowMutation.isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-2" />
          )}
          Check now
        </Button>
      </div>

      {overviewQuery.isLoading && (
        <p className="text-sm text-muted-foreground">Loading CLI versions…</p>
      )}
      {overviewQuery.isError && (
        <p className="text-sm text-destructive">
          {getErrorMessage(overviewQuery.error, 'Failed to load CLI versions.')}
        </p>
      )}

      {overviewProviders && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Provider</TableHead>
                <TableHead scope="col">Version</TableHead>
                <TableHead scope="col">Managed by DevChain on this PC</TableHead>
                <TableHead scope="col">This PC</TableHead>
                {remotesView.map((remote) => (
                  <TableHead key={remote.id} scope="col">
                    <span className="flex items-center gap-1">
                      {remote.name}
                      <span
                        className={
                          remote.online
                            ? 'inline-block h-2 w-2 rounded-full bg-status-ok'
                            : 'inline-block h-2 w-2 rounded-full bg-muted-foreground/40'
                        }
                        title={remote.online ? 'Online' : 'Offline'}
                      />
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {PROVIDER_CLI_NAMES.map((provider) => {
                const { setting, lookup, install } = overviewProviders[provider];
                const label = providerName(provider);
                const pinOptions = lookup?.versions ?? [];
                const currentIncluded =
                  setting.version === LATEST || pinOptions.includes(setting.version);
                const pc = thisPcStatus(install, setting.homeManaged);
                return (
                  <TableRow key={provider} aria-label={`${label} CLI version`}>
                    <TableCell className="font-medium">{label}</TableCell>
                    <TableCell>
                      <Select
                        value={setting.version}
                        onValueChange={(version) =>
                          handleSave(provider, { version, homeManaged: setting.homeManaged })
                        }
                        disabled={setEntryMutation.isPending}
                      >
                        <SelectTrigger className="w-[140px]" aria-label={`${label} version`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={LATEST}>Latest</SelectItem>
                          {currentIncluded || (
                            <SelectItem value={setting.version}>
                              {setting.version} (pinned)
                            </SelectItem>
                          )}
                          {pinOptions.map((version) => (
                            <SelectItem key={version} value={version}>
                              {version}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={setting.homeManaged}
                        onCheckedChange={(homeManaged) =>
                          handleSave(provider, { version: setting.version, homeManaged })
                        }
                        disabled={setEntryMutation.isPending}
                        aria-label={`Managed by DevChain on this PC: ${label}`}
                      />
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-col gap-0.5">
                        <span className={PC_TONE_CLASSES[pc.tone]}>
                          {pc.tone === 'busy' && (
                            <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                          )}
                          {pc.text}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {lookup?.error ? (
                            <span className="text-destructive" title={lookup.error}>
                              Last check failed
                            </span>
                          ) : (
                            <>Latest {lookup?.latestVersion ?? '—'}</>
                          )}
                          {' · '}
                          Checked {formatTimestamp(lookup?.checkedAt ?? null)}
                        </span>
                      </span>
                    </TableCell>
                    {remotesView.map((remote) => (
                      <TableCell key={remote.id}>
                        <VmCliCell remote={remote} provider={provider} />
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}

              <TableRow aria-label={`${providerName('agy')} CLI version`}>
                <TableCell className="font-medium">{providerName('agy')}</TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground">Read-only</span>
                </TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground">—</span>
                </TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground">Not managed</span>
                </TableCell>
                {remotesView.map((remote) => (
                  <TableCell key={remote.id}>
                    {remote.cliVersions?.agy ? (
                      <span
                        className={remote.online ? 'text-xs' : 'text-xs text-muted-foreground'}
                        title={remote.online ? undefined : 'Offline — last known version'}
                      >
                        {remote.cliVersions.agy}
                        {!remote.online && ' (stale)'}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
        </div>
      )}

      {overviewProviders && (
        <p className="mt-2 text-xs text-muted-foreground">
          Latest tracks the newest stable release; a pinned version stays until you change it.
        </p>
      )}
    </section>
  );
}
