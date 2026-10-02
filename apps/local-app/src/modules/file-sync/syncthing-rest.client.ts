import { z } from 'zod';
import { AppError } from '../../common/errors/error-types';

const DEFAULT_TIMEOUT_MS = 5_000;

const VersionSchema = z.object({ version: z.string() });
const StatusSchema = z.object({ myID: z.string() });
const RestartRequiredSchema = z.object({ requiresRestart: z.boolean() });

/** Options DevChain owns on its instance; everything else keeps Syncthing's default. */
export interface SyncthingOptionsPatch {
  listenAddresses: string[];
  globalAnnounceEnabled: boolean;
  localAnnounceEnabled: boolean;
  relaysEnabled: boolean;
  natEnabled: boolean;
  urAccepted: number;
  crashReportingEnabled: boolean;
  autoUpgradeIntervalH: number;
}

/** A Syncthing REST call failed: unreachable, timed out, or answered with a non-2xx status. */
export class SyncthingRestError extends AppError {
  constructor(message: string, details: { path: string; status: number | null }) {
    super(message, 'SYNCTHING_REST_FAILED', 502, details);
  }

  get status(): number | null {
    return (this.details?.status as number | null | undefined) ?? null;
  }
}

/**
 * Client for one Syncthing instance's REST API on loopback. The API key goes
 * only into the request header, never into messages or errors.
 */
export class SyncthingRestClient {
  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async ping(timeoutMs = 1_000): Promise<void> {
    await this.request('GET', '/rest/system/ping', undefined, timeoutMs);
  }

  async version(): Promise<string> {
    return VersionSchema.parse(await this.request('GET', '/rest/system/version')).version;
  }

  async deviceId(): Promise<string> {
    return StatusSchema.parse(await this.request('GET', '/rest/system/status')).myID;
  }

  async getOptions(): Promise<Record<string, unknown>> {
    return z.record(z.unknown()).parse(await this.request('GET', '/rest/config/options'));
  }

  async patchOptions(patch: SyncthingOptionsPatch): Promise<void> {
    await this.request('PATCH', '/rest/config/options', patch);
  }

  async restartRequired(): Promise<boolean> {
    return RestartRequiredSchema.parse(await this.request('GET', '/rest/config/restart-required'))
      .requiresRestart;
  }

  async shutdown(): Promise<void> {
    await this.request('POST', '/rest/system/shutdown');
  }

  async request(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    timeout.unref?.();
    // The joined signal ends the call when either source fires and carries the
    // reason of the first one, so a cancel surfaces as its own reason instead
    // of a timeout or an unreachable report.
    const requestSignal = signal
      ? AbortSignal.any([timeoutController.signal, signal])
      : timeoutController.signal;
    const route = path.split('?')[0];
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: requestSignal,
        headers: {
          'X-API-Key': this.apiKey,
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      text = await response.text();
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new SyncthingRestError(
        `Syncthing is unreachable (${method} ${route}): ${error instanceof Error ? error.message : String(error)}`,
        { path: route, status: null },
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new SyncthingRestError(
        `Syncthing answered ${response.status} to ${method} ${route}: ${text.slice(0, 200)}`,
        { path: route, status: response.status },
      );
    }
    return text ? (JSON.parse(text) as unknown) : null;
  }
}
