export const REMOTE_OPERATION_TIMING = Symbol('REMOTE_OPERATION_TIMING');

/** Waits of the claim and host-update steps; tests shorten them. */
export interface RemoteOperationTiming {
  pollIntervalMs: number;
  /**
   * How long the bootstrap may report `claiming` (installing DevChain and the
   * CLIs) after the claim request itself got no answer: Node's fetch drops a
   * request after 300 s without response headers, whatever its abort timeout.
   */
  claimInstallTimeoutMs: number;
  /** From a recorded claim until DevChain answers on the VM (the install ran before). */
  claimStartTimeoutMs: number;
  /** From the update request until the host answers with the new version. */
  hostUpdateTimeoutMs: number;
}

export const DEFAULT_REMOTE_OPERATION_TIMING: RemoteOperationTiming = {
  pollIntervalMs: 2_000,
  claimInstallTimeoutMs: 45 * 60_000,
  claimStartTimeoutMs: 10 * 60_000,
  hostUpdateTimeoutMs: 45 * 60_000,
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}
