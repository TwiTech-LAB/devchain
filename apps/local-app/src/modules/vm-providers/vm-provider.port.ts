export type VmPowerState = 'running' | 'stopped' | 'unknown';

export interface VmProvider {
  readonly kind: 'address' | 'proxmox';
  readonly capabilities: Readonly<{ create: boolean; destroy: boolean; powerState: boolean }>;
  destroyVm(vmIdentity: string): Promise<void>;
  getPowerState(vmIdentity: string): Promise<VmPowerState>;
  checkPermissions(): Promise<{ ok: boolean; missing: string[] }>;
}
