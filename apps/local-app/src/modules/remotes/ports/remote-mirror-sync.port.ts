export const REMOTE_MIRROR_SYNC_PORT = Symbol('RemoteMirrorSyncPort');

export interface RemoteMirrorSyncPort {
  /**
   * Pulls a connected project's host changes into home's mirror once, starting
   * after any pull already in flight. Resolves at once for a project home owns;
   * a host that cannot be reached leaves the mirror as it is.
   */
  pullNow(projectId: string): Promise<void>;
}
