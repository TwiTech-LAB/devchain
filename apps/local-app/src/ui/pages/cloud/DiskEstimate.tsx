import { useMemo, useState } from 'react';
import { Button } from '@/ui/components/ui/button';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { useRemoteVmApi } from './lib/remote-vm-api-context';
import { getErrorMessage } from '@/ui/lib/toast-helpers';
import { formatBytes } from './file-sync-display';
import { ProjectList, type ProjectListData } from './ProjectList';
import type { EstimatedProject } from './lib/remote-vm-contracts';

const GIB = 1024 ** 3;
/** The OS releases the installer accepts (`host-install-block.ts`). */
export const SUPPORTED_VM_OS = 'Ubuntu 22.04+ or Debian 12+, amd64';
/** The VM's free disk without any project. */
const BASE_DISK_GIB = 8;

function requiredDiskGib(projects: EstimatedProject[]): number {
  const knownBytes = projects.reduce((total, project) => total + (project.bytes ?? 0), 0);
  return Math.ceil(BASE_DISK_GIB + (1.5 * knownBytes) / GIB);
}

/**
 * Which projects count toward the VM's free disk, and their measured sizes.
 * No project starts selected; the required disk is known once each
 * selected project is measured.
 */
export function useDiskEstimate(projectIds: readonly string[]) {
  const api = useRemoteVmApi();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [estimated, setEstimated] = useState<Record<string, EstimatedProject>>({});
  const [measured, setMeasured] = useState<{ key: string; requiredDiskGib: number } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedIds = useMemo(
    () => projectIds.filter((projectId) => selected.has(projectId)),
    [projectIds, selected],
  );
  const selectionKey = selectedIds.join(',');
  const allMeasured = selectedIds.every((projectId) => estimated[projectId] !== undefined);
  let requiredDisk: number | null = null;
  if (allMeasured) {
    requiredDisk =
      measured?.key === selectionKey
        ? measured.requiredDiskGib
        : requiredDiskGib(selectedIds.map((projectId) => estimated[projectId]));
  }

  const toggle = (projectId: string, include: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (include) next.add(projectId);
      else next.delete(projectId);
      return next;
    });

  const measure = async () => {
    if (selectedIds.length === 0) return;
    setPending(true);
    setError(null);
    try {
      const body = await api.estimateProjectDisk(selectedIds);
      setEstimated((current) => ({
        ...current,
        ...Object.fromEntries(body.projects.map((project) => [project.id, project])),
      }));
      setMeasured({ key: selectionKey, requiredDiskGib: body.requiredDiskGib });
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not measure project sizes.'));
    } finally {
      setPending(false);
    }
  };

  return {
    selected,
    selectedIds,
    estimated,
    requiredDisk,
    pending,
    error,
    toggle,
    measure,
  };
}

export type DiskEstimateState = ReturnType<typeof useDiskEstimate>;

function freeDiskText(estimate: DiskEstimateState): string {
  if (estimate.requiredDisk === null) return 'measure the selected projects';
  if (estimate.selectedIds.length === 0) {
    return `${BASE_DISK_GIB} GiB (base requirement; no projects selected)`;
  }
  return `${estimate.requiredDisk} GiB`;
}

function sizeText(result: EstimatedProject | undefined): string {
  if (!result) return 'not measured';
  if (result.bytes === null) return 'unknown';
  return `${formatBytes(result.bytes)}${result.approximate ? ' · approximate' : ''}`;
}

/** The VM requirements, with the free disk the selected projects need. */
export function VmRequirements({ estimate }: { estimate: DiskEstimateState }) {
  return (
    <section aria-label="VM requirements" className="rounded-md border p-3 text-sm">
      <p className="font-medium">VM requirements</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>{SUPPORTED_VM_OS}.</li>
        <li>At least 4 GiB RAM; 8 GiB is advised.</li>
        <li>Internet access and SSH reachability from this PC.</li>
        <li>Use a dedicated VM on a trusted LAN or VPN, never a public address.</li>
        <li>
          Free disk required: <strong>{freeDiskText(estimate)}</strong>
        </li>
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        The installer removes snapd, the user session bus and any keyring.
      </p>
    </section>
  );
}

/** Picks the projects that count toward the free disk, and measures them. */
export function DiskEstimate({
  estimate,
  projects,
  disabled,
}: {
  estimate: DiskEstimateState;
  projects: ProjectListData;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2">
      <ProjectList
        {...projects}
        title="Projects in the disk estimate"
        description="The VM needs room for the projects you plan to run there."
        renderAction={({ project }) => (
          <span className="flex items-center gap-3">
            <span className="text-xs tabular-nums text-muted-foreground">
              {sizeText(estimate.estimated[project.id])}
            </span>
            <Checkbox
              checked={estimate.selected.has(project.id)}
              onCheckedChange={(checked) => estimate.toggle(project.id, checked === true)}
              disabled={disabled || estimate.pending}
              aria-label={`Include ${project.name}`}
            />
          </span>
        )}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void estimate.measure()}
          disabled={disabled || estimate.selectedIds.length === 0}
          pending={estimate.pending}
        >
          {estimate.pending ? 'Measuring…' : 'Measure'}
        </Button>
        {estimate.error && (
          <p role="alert" className="text-sm text-destructive">
            {estimate.error}
          </p>
        )}
      </div>
    </div>
  );
}
