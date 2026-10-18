/** A refused provider-auth request; `details` carries the server's code and context. */
export class ProviderAuthApiError extends Error {
  readonly status: number;
  readonly details: Record<string, unknown> | null;

  constructor(message: string, status: number, details: Record<string, unknown> | null) {
    super(message);
    this.name = 'ProviderAuthApiError';
    this.status = status;
    this.details = details;
  }
}

export class FileListChangedError extends Error {}

export class SharedVmGuardApiError extends Error {
  constructor(
    message: string,
    readonly context: import('./remote-vm-contracts').SharedVmGuardContext,
  ) {
    super(message);
    this.name = 'SharedVmGuardApiError';
  }
}
