import type { RemoteSharedVmService } from '../../modules/remotes/services/remote-shared-vm.service';

export function sharedVmGuardStub(): RemoteSharedVmService {
  return {
    assertAllowed: async () => ({ unavailable: false, instances: [] }),
    context: async () => ({ occupancy: { unavailable: false, instances: [] }, lastRoster: null }),
    lastRoster: () => null,
    notify: async () => ({ results: [] }),
    fencedDestroy: async (input: Parameters<RemoteSharedVmService['fencedDestroy']>[0]) =>
      input.destroy(),
  } as unknown as RemoteSharedVmService;
}
