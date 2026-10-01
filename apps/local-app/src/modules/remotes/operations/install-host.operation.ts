import { Inject, Injectable, Optional } from '@nestjs/common';
import { setTimeout as abortableSleep } from 'node:timers/promises';
import { createLogger } from '../../../common/logging/logger';
import { normalizeCertificate } from '../../../common/tls/certificate';
import { STORAGE_SERVICE, type RemoteStorage } from '../../storage/interfaces/storage.interface';
import { HOST_CERTIFICATE_PATH } from '../host-install/host-install-block';
import { HostInstallService } from '../host-install/host-install.service';
import {
  shellQuote,
  SSH_COMMAND_TIMEOUT_MS,
  SshRunner,
  type SshCredentials,
  type SshSession,
} from '../host-install/ssh-runner';
import { ClaimOperation, type ClaimDetails } from './claim.operation';
import { MIN_HOST_IMAGE_VERSION, isSupportedHostImage } from '../host-image';
import { RemoteHostClient } from './remote-host.client';
import { RemoteOperationStepRefusedError } from './remote-operation.errors';
import {
  stepStarted,
  prefixSteps,
  withStepPrefix,
  type RemoteOperationDefinition,
  type RemoteOperationStepDefinition,
  type RemoteOperationStepRun,
} from './remote-operation.types';
import type { RemoteOperation } from '../../storage/models/domain.models';

const logger = createLogger('InstallHostOperation');
const INSTALL_LOG = '/var/log/devchain-host-install.log';
const INSTALL_EXIT = '/run/devchain-host-install.exit';
const INSTALL_UNIT = 'devchain-host-install';
const PEM_CERTIFICATE =
  /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/;
// sudo's password and authentication failures; anything else (not a sudoer, no sudo) is shown as is.
const SUDO_PASSWORD_FAILURE =
  /password is required|no password was provided|incorrect password|sorry, try again|authentication fail/i;
export const HOST_INSTALL_PREFLIGHT_TIMEOUT_MS = 12 * 60_000;

export interface InstallHostTiming {
  installTimeoutMs: number;
  bootstrapTimeoutMs: number;
  pollIntervalMs: number;
}

export const INSTALL_HOST_TIMING = Symbol('INSTALL_HOST_TIMING');
const DEFAULT_TIMING: InstallHostTiming = {
  installTimeoutMs: 30 * 60_000,
  bootstrapTimeoutMs: 60_000,
  pollIntervalMs: 2_000,
};

export interface InstallHostDetails extends ClaimDetails {
  address: string;
  sshUser: string;
  sshAuthKind: 'password' | 'key';
  sshKeyName?: string;
  hostKeyFingerprint?: string;
  minDiskGib: number;
  checkWarnings?: string[];
  name?: string;
  installStopRequired?: boolean;
}

@Injectable()
export class InstallHostOperation implements RemoteOperationDefinition {
  readonly kind = 'install_host' as const;
  readonly steps: readonly RemoteOperationStepDefinition[];
  private readonly credentials = new Map<string, SshCredentials>();
  private readonly timing: InstallHostTiming;
  private readonly cancellations = new Map<string, AbortController>();

  constructor(
    private readonly ssh: SshRunner,
    private readonly hostInstall: HostInstallService,
    private readonly host: RemoteHostClient,
    private readonly claim: ClaimOperation,
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    @Optional() @Inject(INSTALL_HOST_TIMING) timing?: InstallHostTiming,
  ) {
    this.timing = timing ?? DEFAULT_TIMING;
    this.steps = [
      { id: 'ssh_connect', label: 'Connect to the VM over SSH', run: (run) => this.connect(run) },
      { id: 'check', label: 'Check the VM requirements', run: (run) => this.check(run) },
      { id: 'install', label: 'Install the DevChain host', run: (run) => this.install(run) },
      {
        id: 'wait_bootstrap',
        label: 'Wait for the installer',
        run: (run) => this.waitBootstrap(run),
      },
      ...prefixSteps(claim.steps, 'claim_'),
    ];
  }

  seedCredentials(operationId: string, credentials: SshCredentials): void {
    this.credentials.set(operationId, { ...credentials });
  }

  hasCredentials(operationId: string): boolean {
    return this.credentials.has(operationId);
  }

  assertCancellable(operation: RemoteOperation): void {
    if (stepStarted(operation, 'claim_claim')) {
      this.claim.assertCancellable(claimOperation(operation));
    }
  }

  interrupt(operationId: string): Promise<void> {
    this.cancellation(operationId).abort();
    return this.claim.interrupt(operationId);
  }

  forget(operationId: string): void {
    this.credentials.delete(operationId);
    this.cancellations.delete(operationId);
    this.claim.forget(operationId);
  }

  async completed(operation: RemoteOperation): Promise<void> {
    this.forget(operation.id);
  }

  retryFrom(operation: RemoteOperation): string | null {
    // A failed cancel leaves its controller aborted; a retry starts clean.
    this.cancellations.delete(operation.id);
    const retry = this.claim.retryFrom(claimOperation(operation));
    return retry ? `claim_${retry}` : null;
  }

  async rollback(operation: RemoteOperation): Promise<void> {
    const details = operation.details as unknown as InstallHostDetails;
    if (details.installStopRequired) {
      const credentials = this.requireCredentials(operation.id);
      await this.ssh.withSession(
        { host: details.address, credentials, expectedFingerprint: requireFingerprint(details) },
        (session) => this.stopInstall(session, credentials, details),
      );
    }
    await this.claim.rollback(claimOperation(operation));
    this.forget(operation.id);
  }

  private async connect({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const install = details as unknown as InstallHostDetails;
    const credentials = this.requireCredentials(operation.id);
    install.hostKeyFingerprint = await this.ssh.connect({
      host: install.address,
      credentials,
      expectedFingerprint: install.hostKeyFingerprint,
    });
  }

  private async check({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const install = details as unknown as InstallHostDetails;
    const { signal } = this.cancellation(operation.id);
    signal.throwIfAborted();
    install.checkWarnings = [];
    const credentials = this.requireCredentials(operation.id);
    const block = await this.renderBlock(install, true);
    const collidingHome = await this.ssh.withSession(
      {
        host: install.address,
        credentials,
        expectedFingerprint: requireFingerprint(install),
      },
      async (session) => {
        await this.probeSudo(session, credentials, signal);
        const path = await session.uploadTemp(block, { signal });
        const result = await session.exec(
          privilegedCommand(credentials, `bash ${shellQuote(path)} --check`),
          sudoInput(credentials),
          { timeoutMs: HOST_INSTALL_PREFLIGHT_TIMEOUT_MS, signal },
        );
        install.checkWarnings = `${result.stdout}\n${result.stderr}`
          .split(/\r?\n/)
          .filter((line) => line.startsWith('WARNING: '))
          .map((line) => line.slice('WARNING: '.length));
        if (result.code !== 0) {
          const refusal = tail(`${result.stdout}\n${result.stderr}`.trim(), 2_000);
          throw new RemoteOperationStepRefusedError(
            'HOST_INSTALL_CHECK_FAILED',
            refusal || 'The VM refused the host installation check.',
          );
        }

        const account = await session.exec(
          accountHomeCheckCommand(install.userName, install.homePath),
          '',
          { signal },
        );
        if (account.code === 0) {
          logger.info(
            { operationId: operation.id },
            'Host install will reuse the existing account',
          );
        } else if (account.code === ACCOUNT_HOME_MISMATCH_EXIT) {
          return account.stdout;
        } else if (account.code !== 2) {
          throw new RemoteOperationStepRefusedError(
            'HOST_INSTALL_ACCOUNT_CHECK_FAILED',
            'Could not check the requested account on the VM.',
          );
        }
        return undefined;
      },
    );
    // Thrown outside withSession: its error scrubbing would redact this PC's user name and
    // home whenever they equal an SSH or sudo password.
    if (collidingHome !== undefined) {
      throw new RemoteOperationStepRefusedError(
        'HOST_INSTALL_ACCOUNT_COLLISION',
        `The VM account ${install.userName} already uses the home folder ${collidingHome}. ` +
          `Correct that account's home folder to ${install.homePath}, or use a new VM.`,
      );
    }
  }

  /**
   * Every privileged command below runs through sudo; a missing or wrong
   * sudo password must fail here with its own code so the retry form can ask
   * for it instead of surfacing a generic check failure.
   */
  private async probeSudo(
    session: SshSession,
    credentials: SshCredentials,
    signal: AbortSignal,
  ): Promise<void> {
    if (credentials.user === 'root') return;
    // LC_ALL=C keeps sudo's messages in English, so SUDO_PASSWORD_FAILURE matches on any VM locale.
    const probe = await session.exec(
      `env LC_ALL=C ${privilegedCommand(credentials, 'true')}`,
      sudoInput(credentials),
      {
        timeoutMs: SSH_COMMAND_TIMEOUT_MS,
        signal,
      },
    );
    if (probe.code === 0) return;
    if (!SUDO_PASSWORD_FAILURE.test(probe.stderr)) {
      throw new RemoteOperationStepRefusedError(
        'HOST_INSTALL_CHECK_FAILED',
        tail(probe.stderr.trim(), 2_000) || `sudo failed on the VM for ${credentials.user}.`,
      );
    }
    const passwordGiven = sudoInput(credentials).trim() !== '';
    throw new RemoteOperationStepRefusedError(
      'SSH_SUDO_PASSWORD_REQUIRED',
      passwordGiven
        ? `The VM refused the sudo password for ${credentials.user}.`
        : `sudo on the VM needs a password for ${credentials.user}. Enter the sudo password and retry.`,
    );
  }

  private async install({ operation, details, progress }: RemoteOperationStepRun): Promise<void> {
    const install = details as unknown as InstallHostDetails;
    const credentials = this.requireCredentials(operation.id);
    const block = await this.renderBlock(install, false);
    const { signal } = this.cancellation(operation.id);
    signal.throwIfAborted();
    const deadline = Date.now() + this.timing.installTimeoutMs;
    const certificate = await this.ssh.withSession(
      {
        host: install.address,
        credentials,
        expectedFingerprint: requireFingerprint(install),
      },
      async (session) => {
        try {
          const status = await this.installStatus(session, credentials, deadline, signal);
          if (status === 'absent') {
            const path = await session.uploadTemp(block, { deadlineAt: deadline, signal });
            signal.throwIfAborted();
            const start = await session.exec(
              privilegedCommand(credentials, detachedInstallCommand(path)),
              sudoInput(credentials),
              { deadlineAt: deadline, timeoutMs: 5_000 },
            );
            if (start.code !== 0) {
              throw new RemoteOperationStepRefusedError(
                'HOST_INSTALL_START_FAILED',
                tail(start.stderr || start.stdout, 2_000) ||
                  'Could not start the host installation.',
              );
            }
          }
          await this.waitForInstall(session, credentials, progress, deadline, signal);
          signal.throwIfAborted();
          return await this.readCertificate(session, credentials, signal);
        } catch (error) {
          if (signal.aborted) {
            install.installStopRequired = true;
            await this.stopInstall(session, credentials, install);
          }
          throw error;
        }
      },
    );
    // The row is what the claim and later calls pin to; details keep it for retries.
    await this.storage.updateRemoteTlsCertificate(operation.remoteId, certificate);
    install.tlsCertificate = certificate;
  }

  /**
   * The VM certificate, read over the SSH session whose host key the connect step
   * pinned. It is never taken from the network, and never parsed from the
   * install log, which is truncated.
   */
  private async readCertificate(
    session: SshSession,
    credentials: SshCredentials,
    signal: AbortSignal,
  ): Promise<string> {
    const result = await session.exec(
      privilegedCommand(credentials, `cat ${shellQuote(HOST_CERTIFICATE_PATH)}`),
      sudoInput(credentials),
      { timeoutMs: SSH_COMMAND_TIMEOUT_MS, signal },
    );
    if (result.code !== 0) {
      throw new RemoteOperationStepRefusedError(
        'HOST_TLS_CERTIFICATE_UNREADABLE',
        `Could not read the VM certificate ${HOST_CERTIFICATE_PATH} over SSH` +
          (result.stderr.trim() ? `: ${tail(result.stderr.trim(), 300)}` : '.'),
      );
    }
    return parseVmCertificate(result.stdout);
  }

  private async installStatus(
    session: SshSession,
    credentials: SshCredentials,
    deadline: number,
    signal: AbortSignal,
  ): Promise<'active' | 'finished' | 'absent'> {
    const command = `if test -f ${shellQuote(INSTALL_EXIT)}; then printf finished; elif systemctl is-active --quiet ${shellQuote(INSTALL_UNIT)}; then printf active; else printf absent; fi`;
    const result = await session.exec(
      privilegedCommand(credentials, `sh -c ${shellQuote(command)}`),
      sudoInput(credentials),
      { deadlineAt: deadline, signal },
    );
    if (result.code !== 0) {
      throw new RemoteOperationStepRefusedError(
        'HOST_INSTALL_STATUS_FAILED',
        'Could not read the detached installer status.',
      );
    }
    const status = result.stdout.trim();
    return status === 'active' || status === 'finished' ? status : 'absent';
  }

  private async waitForInstall(
    session: SshSession,
    credentials: SshCredentials,
    progress: RemoteOperationStepRun['progress'],
    deadline: number,
    signal: AbortSignal,
  ): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const command = `tail -n 80 ${shellQuote(INSTALL_LOG)} 2>/dev/null || true; printf '\\n__DEVCHAIN_EXIT__'; test ! -f ${shellQuote(INSTALL_EXIT)} || cat ${shellQuote(INSTALL_EXIT)}`;
      const result = await session.exec(
        privilegedCommand(credentials, `sh -c ${shellQuote(command)}`),
        sudoInput(credentials),
        { deadlineAt: deadline, signal },
      );
      if (result.code !== 0) {
        throw new RemoteOperationStepRefusedError(
          'HOST_INSTALL_STATUS_FAILED',
          'Could not read the detached installer log and exit status.',
        );
      }
      const [output, exitText = ''] = result.stdout.split('\n__DEVCHAIN_EXIT__');
      const logTail = tail(output.trim(), 8_000);
      await progress({ install: { tail: logTail } });
      signal.throwIfAborted();
      const exitCode = /^\d+$/.test(exitText.trim()) ? Number(exitText.trim()) : null;
      if (exitCode !== null) {
        if (exitCode !== 0) {
          await session.exec(
            privilegedCommand(credentials, `rm -f ${shellQuote(INSTALL_EXIT)}`),
            sudoInput(credentials),
          );
          throw new RemoteOperationStepRefusedError(
            'HOST_INSTALL_FAILED',
            logTail || `The detached installer failed with code ${exitCode}.`,
          );
        }
        return;
      }
      if (Date.now() >= deadline) {
        throw new RemoteOperationStepRefusedError(
          'HOST_INSTALL_TIMEOUT',
          'The host installation did not finish within 30 minutes.',
        );
      }
      await abortableSleep(Math.min(this.timing.pollIntervalMs, deadline - Date.now()), undefined, {
        signal,
      });
    }
  }

  private async waitBootstrap({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const install = details as unknown as InstallHostDetails;
    const { signal } = this.cancellation(operation.id);
    const certificate =
      install.tlsCertificate ?? (await this.host.certificateOf(operation.remoteId));
    const deadline = Date.now() + this.timing.bootstrapTimeoutMs;
    for (;;) {
      signal.throwIfAborted();
      const runtime = await this.host
        .runtimeAt(install.bootstrapUrl, certificate)
        .catch(() => null);
      if (runtime?.state === 'unclaimed' && isSupportedHostImage(runtime.imageVersion)) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new RemoteOperationStepRefusedError(
          'HOST_BOOTSTRAP_TIMEOUT',
          'The installed host bootstrap did not become ready within 60 seconds.',
        );
      }
      await abortableSleep(Math.min(this.timing.pollIntervalMs, deadline - Date.now()), undefined, {
        signal,
      });
    }
  }

  private cancellation(operationId: string): AbortController {
    let controller = this.cancellations.get(operationId);
    if (!controller) {
      controller = new AbortController();
      this.cancellations.set(operationId, controller);
    }
    return controller;
  }

  private async stopInstall(
    session: SshSession,
    credentials: SshCredentials,
    details: InstallHostDetails,
  ): Promise<void> {
    // Kill the whole unit before stopping it: existing units may have a 90-second stop timeout.
    const unit = shellQuote(INSTALL_UNIT);
    const command = `systemctl kill --signal=SIGKILL ${unit}; systemctl stop ${unit} || { test "$(systemctl show ${unit} --property=LoadState --value)" = not-found || exit 1; }; rm -f ${shellQuote(INSTALL_EXIT)}`;
    const stopped = await session.exec(
      privilegedCommand(credentials, `sh -c ${shellQuote(command)}`),
      sudoInput(credentials),
      { timeoutMs: 5_000 },
    );
    if (stopped.code !== 0) {
      throw new RemoteOperationStepRefusedError(
        'HOST_INSTALL_STOP_FAILED',
        'Could not stop the detached installer and clear its status on the VM. Check SSH access and cancel again.',
      );
    }
    delete details.installStopRequired;
  }

  private requireCredentials(operationId: string): SshCredentials {
    const credentials = this.credentials.get(operationId);
    if (!credentials) {
      throw new RemoteOperationStepRefusedError(
        'SSH_CREDENTIALS_REQUIRED',
        'SSH credentials are required again after restarting DevChain; retry with ssh credentials.',
      );
    }
    return credentials;
  }

  private renderBlock(details: InstallHostDetails, checkOnly: boolean): Promise<string> {
    return this.hostInstall.render({
      minDiskGib: details.minDiskGib,
      homePort: details.port,
      imageVersion: MIN_HOST_IMAGE_VERSION,
      homeUser: details.userName,
      homePath: details.homePath,
      devchainVersion: details.version,
      checkOnly,
    });
  }
}

const ACCOUNT_HOME_MISMATCH_EXIT = 10;

/**
 * Compares the account's home folder on the VM, because captured SSH output is scrubbed of
 * credential values. Exits 0 on a match, 2 when the account does not exist (getent), and
 * ACCOUNT_HOME_MISMATCH_EXIT with the current home on stdout on a mismatch.
 */
export function accountHomeCheckCommand(userName: string, homePath: string): string {
  // Two steps: POSIX sh has no pipefail, so a getent | cut pipeline would lose getent's exit 2.
  const script = `home=$(getent passwd ${shellQuote(userName)}) || exit $?; home=$(printf '%s' "$home" | cut -d: -f6); [ "$home" = ${shellQuote(homePath)} ] && exit 0; printf '%s' "$home"; exit ${ACCOUNT_HOME_MISMATCH_EXIT}`;
  return `sh -c ${shellQuote(script)}`;
}

function detachedInstallCommand(path: string): string {
  const run = `bash "$1"; code=$?; printf '%s\\n' "$code" > ${shellQuote(INSTALL_EXIT)}; exit "$code"`;
  return `systemd-run --unit=${shellQuote(INSTALL_UNIT)} --collect --no-block --property=${shellQuote(`StandardOutput=append:${INSTALL_LOG}`)} --property=${shellQuote(`StandardError=append:${INSTALL_LOG}`)} bash -c ${shellQuote(run)} _ ${shellQuote(path)}`;
}

function privilegedCommand(credentials: SshCredentials, command: string): string {
  return credentials.user === 'root' ? command : `sudo -S -p '' ${command}`;
}

function sudoInput(credentials: SshCredentials): string {
  return credentials.user === 'root'
    ? ''
    : `${credentials.sudoPassword ?? credentials.password ?? ''}\n`;
}

function requireFingerprint(details: InstallHostDetails): string {
  if (!details.hostKeyFingerprint) {
    throw new RemoteOperationStepRefusedError(
      'SSH_HOST_KEY_MISSING',
      'The SSH host key was not recorded; retry the connection step.',
    );
  }
  return details.hostKeyFingerprint;
}

/** Exactly one PEM certificate, normalized; anything else fails the step. */
function parseVmCertificate(output: string): string {
  const pem = output.trim();
  if (PEM_CERTIFICATE.test(pem)) {
    try {
      return normalizeCertificate(pem);
    } catch {
      // Refused below with the same error as a malformed file.
    }
  }
  throw new RemoteOperationStepRefusedError(
    'HOST_TLS_CERTIFICATE_INVALID',
    `The VM certificate ${HOST_CERTIFICATE_PATH} is not a valid PEM certificate. Retry the install step, or use a new VM.`,
  );
}

function tail(value: string, max: number): string {
  return value.length <= max ? value : value.slice(-max);
}

function claimOperation(operation: RemoteOperation): RemoteOperation {
  return withStepPrefix(operation, 'claim_');
}
