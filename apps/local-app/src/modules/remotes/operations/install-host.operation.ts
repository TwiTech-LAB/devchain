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
  type SshCommandResult,
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
  mode?: 'install' | 'join';
  joinExpiresAt?: string;
  joinInstallStarted?: boolean;
  requestedPort?: number;
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

  async retryFrom(operation: RemoteOperation): Promise<string | null> {
    // A failed cancel leaves its controller aborted; a retry starts clean.
    this.cancellations.delete(operation.id);
    const details = operation.details as unknown as InstallHostDetails;
    if (details.mode === 'join' && !details.claimed) {
      if (stepStarted(operation, 'claim_claim') || !this.claim.hasJoinNonce(operation.id))
        return 'install';
      const runtime = details.tlsCertificate
        ? await this.host.runtimeAt(details.bootstrapUrl, details.tlsCertificate).catch(() => null)
        : null;
      if (!runtime) return 'install';
    }
    const retry = this.claim.retryFrom(claimOperation(operation));
    return retry ? `claim_${retry}` : null;
  }

  resumeFrom(operation: RemoteOperation): string | null {
    const details = operation.details as unknown as InstallHostDetails;
    return details.mode === 'join' && !details.claimed ? 'install' : null;
  }

  async rollback(operation: RemoteOperation): Promise<void> {
    const details = operation.details as unknown as InstallHostDetails;
    if (details.installStopRequired) {
      const credentials = this.requireCredentials(operation.id);
      await this.ssh.withSession(
        { host: details.address, credentials, expectedFingerprint: requireFingerprint(details) },
        (session) => this.stopInstall(session, credentials, details, operation.id),
      );
    }
    if (details.mode === 'join' && details.joinRequestId && details.joinInstallStarted) {
      const credentials = this.requireCredentials(operation.id);
      await this.ssh.withSession(
        { host: details.address, credentials, expectedFingerprint: requireFingerprint(details) },
        async (session) => {
          const ownClaim = await session.exec(
            privilegedCommand(
              credentials,
              `test ! -f ${shellQuote(joinedInstancePaths(details.userName).claim)}`,
            ),
            sudoInput(credentials),
          );
          if (ownClaim.code !== 0)
            throw new RemoteOperationStepRefusedError(
              'CLAIM_STARTED',
              'The joined instance is already claimed; cancelling it is refused.',
            );
          const result = await this.joinCommand(session, credentials, details, '--cancel-join');
          if (result.code !== 0)
            throw joinRefusal(
              result,
              'HOST_JOIN_CANCEL_FAILED',
              'Could not cancel the VM join; restore SSH access and cancel again.',
            );
        },
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
    const collidingHome = await this.ssh.withSession(
      {
        host: install.address,
        credentials,
        expectedFingerprint: requireFingerprint(install),
      },
      async (session) => {
        await this.probeSudo(session, credentials, signal);
        const state = await session.exec(
          privilegedCommand(
            credentials,
            "sh -c 'if test -f /etc/devchain-host/claim.json; then printf __DEVCHAIN_HOST_STATE__claimed; else printf __DEVCHAIN_HOST_STATE__unclaimed; fi'",
          ),
          sudoInput(credentials),
          { signal, capture: 'private' },
        );
        if (
          state.code !== 0 ||
          !['__DEVCHAIN_HOST_STATE__claimed', '__DEVCHAIN_HOST_STATE__unclaimed'].includes(
            state.stdout.trim(),
          )
        )
          throw new RemoteOperationStepRefusedError(
            'HOST_INSTALL_CHECK_FAILED',
            'Could not inspect the VM claim state.',
          );
        install.mode =
          state.stdout.trim() === '__DEVCHAIN_HOST_STATE__claimed' ? 'join' : 'install';
        if (install.mode === 'join') {
          install.joinRequestId = operation.id;
          install.requestedPort ??= install.port;
        }
        const block = await this.renderBlock(install, true);
        const path = await session.uploadTemp(block, { signal });
        const result = await session.exec(
          privilegedCommand(credentials, `bash ${shellQuote(path)} --check`),
          sudoInput(credentials),
          {
            timeoutMs: HOST_INSTALL_PREFLIGHT_TIMEOUT_MS,
            signal,
            ...(install.mode === 'join' ? { capture: 'private' as const } : {}),
          },
        );
        install.checkWarnings = `${result.stdout}\n${result.stderr}`
          .split(/\r?\n/)
          .filter((line) => line.startsWith('WARNING: '))
          .map((line) => line.slice('WARNING: '.length));
        if (result.code !== 0) {
          if (install.mode === 'join') {
            const refusal = parseJoinError(result);
            if (refusal?.code === 'HOST_INSTALL_ACCOUNT_COLLISION')
              return refusal.accountHome ?? 'another folder';
            return {
              joinError: refusal ?? {
                code: 'HOST_JOIN_CHECK_FAILED',
                message: 'The VM refused the join check.',
              },
            };
          }
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
    if (collidingHome && typeof collidingHome === 'object')
      throw new RemoteOperationStepRefusedError(
        collidingHome.joinError.code,
        collidingHome.joinError.message,
      );
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
    if (install.mode === 'join') {
      await this.installJoin({ operation, details, progress }, credentials);
      return;
    }
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
          const status = await this.installStatus(
            session,
            credentials,
            deadline,
            signal,
            operation.id,
          );
          if (status === 'absent') {
            const path = await session.uploadTemp(block, { deadlineAt: deadline, signal });
            signal.throwIfAborted();
            const start = await session.exec(
              privilegedCommand(credentials, detachedInstallCommand(path, operation.id)),
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
          await this.waitForInstall(session, credentials, progress, deadline, signal, operation.id);
          signal.throwIfAborted();
          return await this.readCertificate(session, credentials, signal);
        } catch (error) {
          if (signal.aborted) {
            install.installStopRequired = true;
            await this.stopInstall(session, credentials, install, operation.id);
          }
          throw error;
        }
      },
    );
    // The row is what the claim and later calls pin to; details keep it for retries.
    await this.storage.updateRemoteTlsCertificate(operation.remoteId, certificate);
    install.tlsCertificate = certificate;
  }

  private async installJoin(
    run: RemoteOperationStepRun,
    credentials: SshCredentials,
    deadline = Date.now() + this.timing.installTimeoutMs,
  ): Promise<void> {
    const { operation, progress } = run;
    const details = run.details as unknown as InstallHostDetails;
    const { signal } = this.cancellation(operation.id);
    signal.throwIfAborted();
    await this.ssh.withSession(
      { host: details.address, credentials, expectedFingerprint: requireFingerprint(details) },
      async (session) => {
        try {
          if (stepStarted(operation, 'claim_claim')) {
            const claimFile = joinedInstancePaths(details.userName).claim;
            for (;;) {
              signal.throwIfAborted();
              const recorded = await session.exec(
                privilegedCommand(
                  credentials,
                  `sh -c ${shellQuote(`if test -f ${shellQuote(claimFile)}; then cat ${shellQuote(claimFile)}; fi`)}`,
                ),
                sudoInput(credentials),
                { signal, deadlineAt: deadline, capture: 'private' },
              );
              if (recorded.code !== 0)
                throw new RemoteOperationStepRefusedError(
                  'HOST_JOIN_STATE_FAILED',
                  'Could not inspect this instance after the earlier claim.',
                );
              if (recorded.stdout.trim()) {
                const record: unknown = JSON.parse(recorded.stdout);
                if (
                  !isJoinRecord(record, details) ||
                  record.port !== details.port ||
                  record.version !== details.version
                )
                  throw new RemoteOperationStepRefusedError(
                    'INSTANCE_EXISTS',
                    'The existing instance does not match this join attempt.',
                  );
                const started = await session.exec(
                  privilegedCommand(
                    credentials,
                    `systemctl start --no-block ${shellQuote(joinedInstancePaths(details.userName).unit)}`,
                  ),
                  sudoInput(credentials),
                  { signal },
                );
                if (started.code !== 0)
                  throw new RemoteOperationStepRefusedError(
                    'HOST_JOIN_START_FAILED',
                    'Could not start the recorded instance service.',
                  );
                await this.saveJoinedAddress(
                  operation.remoteId,
                  details,
                  session,
                  credentials,
                  signal,
                );
                details.claimed = true;
                return;
              }
              const certificate =
                details.tlsCertificate ?? (await this.host.certificateOf(operation.remoteId));
              const runtime = await this.host
                .runtimeAt(details.bootstrapUrl, certificate)
                .catch(() => null);
              if (!claimInFlight(runtime)) break;
              if (Date.now() >= deadline)
                throw new RemoteOperationStepRefusedError(
                  'HOST_JOIN_CLAIM_TIMEOUT',
                  'The earlier claim did not record this instance within the installation timeout.',
                );
              await abortableSleep(
                Math.min(this.timing.pollIntervalMs, deadline - Date.now()),
                undefined,
                { signal },
              );
            }
          }
          details.joinInstallStarted = true;
          await progress({ joinInstallStarted: true }, { durable: true });
          const status = await this.installStatus(
            session,
            credentials,
            deadline,
            signal,
            operation.id,
          );
          if (status === 'absent') {
            const file = await session.uploadTemp(await this.renderBlock(details, false), {
              signal,
              deadlineAt: deadline,
            });
            const result = await session.exec(
              privilegedCommand(credentials, detachedInstallCommand(file, operation.id)),
              sudoInput(credentials),
              { deadlineAt: deadline, timeoutMs: 5_000 },
            );
            if (result.code !== 0)
              throw new RemoteOperationStepRefusedError(
                'HOST_JOIN_START_FAILED',
                'Could not start the detached VM join.',
              );
          }
          await this.waitForInstall(
            session,
            credentials,
            progress,
            deadline,
            signal,
            operation.id,
            true,
          );
          signal.throwIfAborted();
          const result = await this.joinCommand(
            session,
            credentials,
            details,
            '--reserve-join',
            signal,
          );
          if (result.code !== 0)
            throw joinRefusal(
              result,
              'HOST_JOIN_RESERVE_FAILED',
              'Could not resume the join reservation.',
            );
          let reservation: unknown;
          try {
            reservation = JSON.parse(result.stdout);
          } catch {
            throw new RemoteOperationStepRefusedError(
              'HOST_JOIN_RESERVATION_INVALID',
              'The VM returned an invalid join reservation.',
            );
          }
          if (
            !isJoinRecord(reservation, details) ||
            typeof reservation.nonce !== 'string' ||
            !/^[a-f0-9]{64}$/.test(reservation.nonce) ||
            reservation.requestId !== details.joinRequestId ||
            typeof reservation.expiresAt !== 'string' ||
            !Number.isFinite(Date.parse(reservation.expiresAt))
          )
            throw new RemoteOperationStepRefusedError(
              'HOST_JOIN_RESERVATION_INVALID',
              'The VM returned a mismatched join reservation.',
            );
          this.claim.seedJoinNonce(operation.id, reservation.nonce);
          details.port = reservation.port;
          details.joinExpiresAt = reservation.expiresAt;
          const url = new URL(details.bootstrapUrl);
          url.port = String(reservation.port);
          url.protocol = 'https:';
          details.bootstrapUrl = url.origin;
          await progress(
            {
              port: details.port,
              bootstrapUrl: details.bootstrapUrl,
              joinExpiresAt: details.joinExpiresAt,
            },
            { durable: true },
          );
          await this.saveJoinedAddress(operation.remoteId, details, session, credentials, signal);
        } catch (error) {
          if (signal.aborted) {
            details.installStopRequired = true;
            await this.stopInstall(session, credentials, details, operation.id);
          }
          throw error;
        }
      },
    );
  }

  private async saveJoinedAddress(
    remoteId: string,
    details: InstallHostDetails,
    session: SshSession,
    credentials: SshCredentials,
    signal: AbortSignal,
  ): Promise<void> {
    const certificate = await this.readCertificate(session, credentials, signal);
    await this.storage.updateRemoteBaseUrl(remoteId, details.bootstrapUrl);
    await this.storage.updateRemoteTlsCertificate(remoteId, certificate);
    details.tlsCertificate = certificate;
  }

  private async joinCommand(
    session: SshSession,
    credentials: SshCredentials,
    details: InstallHostDetails,
    mode: '--reserve-join' | '--cancel-join',
    signal?: AbortSignal,
  ): Promise<SshCommandResult> {
    const input = {
      userName: details.userName,
      homePath: details.homePath,
      port: details.requestedPort ?? details.port,
      requestId: details.joinRequestId,
      uid: details.uid,
      gid: details.gid,
    };
    const file = await session.uploadTemp(JSON.stringify(input), { signal });
    const own = joinedInstancePaths(details.userName);
    const helper = own.bootstrap;
    const cleanup = `test ! -f ${shellQuote(own.claim)} && test ! -f ${shellQuote(own.join)} || exit 3; rm -rf ${shellQuote(own.prefix)}`;
    const command =
      mode === '--cancel-join'
        ? `if test -x ${shellQuote(helper)}; then ${shellQuote(helper)} ${mode} <${shellQuote(file)} || exit $?; else printf '{"cancelled":true}\\n'; fi; flock --exclusive /etc/devchain-host/registry.lock sh -c ${shellQuote(cleanup)}`
        : `${shellQuote(helper)} ${mode} <${shellQuote(file)}`;
    try {
      return await session.exec(
        privilegedCommand(credentials, `sh -c ${shellQuote(command)}`),
        sudoInput(credentials),
        { signal, timeoutMs: SSH_COMMAND_TIMEOUT_MS, capture: 'private' },
      );
    } finally {
      await session.exec(`rm -f ${shellQuote(file)}`).catch(() => undefined);
    }
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
      { timeoutMs: SSH_COMMAND_TIMEOUT_MS, signal, capture: 'private' },
    );
    if (result.code !== 0) {
      throw new RemoteOperationStepRefusedError(
        'HOST_TLS_CERTIFICATE_UNREADABLE',
        `Could not read the VM certificate ${HOST_CERTIFICATE_PATH} over SSH.`,
      );
    }
    return parseVmCertificate(result.stdout);
  }

  private async installStatus(
    session: SshSession,
    credentials: SshCredentials,
    deadline: number,
    signal: AbortSignal,
    operationId: string,
  ): Promise<'active' | 'finished' | 'absent'> {
    const job = installJobPaths(operationId);
    const command = `if test -f ${shellQuote(job.exit)}; then printf finished; elif systemctl is-active --quiet ${shellQuote(job.unit)}; then printf active; else printf absent; fi`;
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
    operationId: string,
    join = false,
  ): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const job = installJobPaths(operationId);
      const command = `tail -n 80 ${shellQuote(job.log)} 2>/dev/null || true; printf '\\n__DEVCHAIN_EXIT__'; test ! -f ${shellQuote(job.exit)} || cat ${shellQuote(job.exit)}`;
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
            privilegedCommand(credentials, `rm -f ${shellQuote(job.exit)}`),
            sudoInput(credentials),
          );
          if (join)
            throw joinRefusal(
              { code: exitCode, stdout: logTail, stderr: '' },
              'HOST_JOIN_FAILED',
              'The detached VM join failed.',
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

  private async waitBootstrap(run: RemoteOperationStepRun): Promise<void> {
    const { operation, details } = run;
    const install = details as unknown as InstallHostDetails;
    const { signal } = this.cancellation(operation.id);
    const certificate =
      install.tlsCertificate ?? (await this.host.certificateOf(operation.remoteId));
    const recoveringClaim =
      install.mode === 'join' && !install.claimed && stepStarted(operation, 'claim_claim');
    let deadline =
      Date.now() +
      (recoveringClaim ? this.timing.installTimeoutMs : this.timing.bootstrapTimeoutMs);
    for (;;) {
      signal.throwIfAborted();
      const runtime = await this.host
        .runtimeAt(install.bootstrapUrl, certificate)
        .catch(() => null);
      if (runtime?.state === 'unclaimed' && isSupportedHostImage(runtime.imageVersion)) {
        return;
      }
      if (recoveringClaim && !install.claimed && Date.now() >= deadline)
        throw new RemoteOperationStepRefusedError(
          'HOST_JOIN_CLAIM_TIMEOUT',
          'The earlier claim did not record this instance within the installation timeout.',
        );
      if (recoveringClaim && !install.claimed && claimInFlight(runtime)) {
        await this.installJoin(run, this.requireCredentials(operation.id), deadline);
        if (install.claimed) deadline = Date.now() + this.timing.bootstrapTimeoutMs;
        continue;
      }
      if (install.mode === 'join' && install.claimed && runtime?.version === install.version)
        return;
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
    operationId: string,
  ): Promise<void> {
    // Kill the whole unit before stopping it: existing units may have a 90-second stop timeout.
    const job = installJobPaths(operationId);
    const unit = shellQuote(job.unit);
    const command = `systemctl kill --signal=SIGKILL ${unit}; systemctl stop ${unit} || { test "$(systemctl show ${unit} --property=LoadState --value)" = not-found || exit 1; }; rm -f ${shellQuote(job.exit)}`;
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
    if (details.mode === 'join')
      return this.hostInstall.renderJoin({
        minDiskGib: details.minDiskGib,
        homePort: details.requestedPort ?? details.port,
        homeUser: details.userName,
        homePath: details.homePath,
        uid: details.uid,
        gid: details.gid,
        requestId: details.joinRequestId ?? '',
        checkOnly,
      });
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

function detachedInstallCommand(path: string, operationId: string): string {
  const job = installJobPaths(operationId);
  const run = `bash "$1"; code=$?; printf '%s\\n' "$code" > ${shellQuote(job.exit)}; exit "$code"`;
  return `systemd-run --unit=${shellQuote(job.unit)} --collect --no-block --property=${shellQuote(`StandardOutput=append:${job.log}`)} --property=${shellQuote(`StandardError=append:${job.log}`)} bash -c ${shellQuote(run)} _ ${shellQuote(path)}`;
}

/** Whether a join bootstrap still runs an earlier claim, or DevChain already answers in its place. */
function claimInFlight(runtime: { state?: string; version?: string | null } | null): boolean {
  return (
    runtime?.state === 'claiming' || runtime?.state === 'handover' || Boolean(runtime?.version)
  );
}

/** A joined instance's VM paths; apps/host-bootstrap/lib/system.js owns the same layout. */
export function joinedInstancePaths(userName: string) {
  const etc = `/etc/devchain-host/instances/${userName}`;
  const prefix = `/opt/devchain-host/instances/${userName}`;
  return {
    claim: `${etc}/claim.json`,
    join: `${etc}/join.json`,
    prefix,
    bootstrap: `${prefix}/helper/bin/devchain-bootstrap`,
    unit: `devchain-user-${userName}.service`,
  };
}

export function installJobPaths(operationId: string): { unit: string; log: string; exit: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(operationId)) throw new Error('Invalid SSH operation id.');
  const unit = `devchain-host-install-${operationId}`;
  return { unit, log: `/var/log/${unit}.log`, exit: `/run/${unit}.exit` };
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

interface JoinRecord {
  userName: string;
  homePath: string;
  port: number;
  version?: unknown;
  nonce?: unknown;
  requestId?: unknown;
  expiresAt?: unknown;
}

function isJoinRecord(value: unknown, details: ClaimDetails): value is JoinRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.userName === details.userName &&
    record.homePath === details.homePath &&
    typeof record.port === 'number' &&
    Number.isInteger(record.port) &&
    record.port >= 1024 &&
    record.port <= 65535
  );
}

interface JoinError {
  code: string;
  message: string;
  accountHome?: string;
}

function parseJoinError(result: SshCommandResult): JoinError | null {
  for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/).reverse()) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object') continue;
      const error = parsed as Record<string, unknown>;
      if (typeof error.code === 'string' && typeof error.message === 'string')
        return {
          code: error.code,
          message: error.message.replace(/\b[a-f0-9]{64}\b/gi, '[REDACTED]'),
          ...(typeof error.accountHome === 'string' ? { accountHome: error.accountHome } : {}),
        };
    } catch {}
  }
  return null;
}

function joinRefusal(
  result: SshCommandResult,
  code: string,
  message: string,
): RemoteOperationStepRefusedError {
  const error = parseJoinError(result);
  return new RemoteOperationStepRefusedError(error?.code ?? code, error?.message ?? message);
}
