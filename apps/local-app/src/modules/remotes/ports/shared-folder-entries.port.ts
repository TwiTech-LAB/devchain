export const SHARED_FOLDER_ENTRIES = Symbol('SharedFolderEntries');

/** This PC's list of user folders shared with VMs, as the share operation needs it. */
export interface SharedFolderEntriesPort {
  /** The path of every shared folder, of every VM. */
  sharedPaths(): readonly string[];
  /** Forgets the entry of `path` for the VM; its patterns go with it. */
  remove(remoteId: string, path: string): void | Promise<void>;
}
