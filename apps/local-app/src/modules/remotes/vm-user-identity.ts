import { z } from 'zod';

/** The claim's requested uid and the VM account that holds it, when one does. */
export const VmUidConflictSchema = z.object({
  requestedUid: z.number().int(),
  holder: z.string().nullable(),
});
export type VmUidConflict = z.infer<typeof VmUidConflictSchema>;

export interface VmUserRuntime {
  uid?: number | null;
  gid?: number | null;
  uidConflict?: VmUidConflict | null;
}

export interface VmUserMismatch {
  homeUid: number | null;
  homeGid: number | null;
  vmUid: number | null;
  vmGid: number | null;
  uidConflict?: VmUidConflict;
}

export function vmUserMismatch(
  homeUid: number | null,
  homeGid: number | null,
  runtime: VmUserRuntime,
): VmUserMismatch | null {
  const vmUid = runtime.uid ?? null;
  const vmGid = runtime.gid ?? null;
  if (homeUid !== null && homeGid !== null && homeUid === vmUid && homeGid === vmGid) return null;
  return {
    homeUid,
    homeGid,
    vmUid,
    vmGid,
    ...(runtime.uidConflict ? { uidConflict: runtime.uidConflict } : {}),
  };
}

/** This PC's ids against a VM runtime's; null when they match or the VM reported none. */
export function reportedVmUserMismatch(runtime: VmUserRuntime): VmUserMismatch | null {
  if (runtime.uid == null && runtime.gid == null) return null;
  return vmUserMismatch(process.getuid?.() ?? null, process.getgid?.() ?? null, runtime);
}

export function userIds(uid: number | null, gid: number | null): string {
  return `${uid ?? 'unknown'}:${gid ?? 'unknown'}`;
}

export function vmUserWarning(mismatch: VmUserMismatch): string {
  const { homeUid, homeGid, vmUid, vmGid, uidConflict } = mismatch;
  const reason = uidConflict?.holder
    ? `uid ${uidConflict.requestedUid} is used by ${uidConflict.holder} on the VM; the VM user got ${userIds(vmUid, vmGid)}.`
    : `The user ids differ (${userIds(homeUid, homeGid)} here, ${userIds(vmUid, vmGid)} on the VM).`;
  return `${reason} Automatic Docker moves are off for this VM.`;
}

export function dockerCopyBackMismatchMessage(mismatch: VmUserMismatch): string {
  return `Docker data is not copied back automatically, because the user ids differ (${userIds(mismatch.homeUid, mismatch.homeGid)} here, ${userIds(mismatch.vmUid, mismatch.vmGid)} on the VM). Copy what you need yourself, for example with a volume export and import.`;
}
