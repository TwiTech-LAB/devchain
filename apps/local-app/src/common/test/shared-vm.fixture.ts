import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FakeBootstrapServer } from './fake-bootstrap.server';
import type { SshCommandResult, SshSession } from '../../modules/remotes/host-install/ssh-runner';

interface VmSystem {
  paths: Record<string, string>;
  now: () => Date;
  run: (command: string, args: string[], options?: unknown) => Promise<SshCommandResult>;
}
interface ClaimRecord {
  userName: string;
  homePath: string;
  version: string;
  port: number;
}
interface FakeSystem {
  root: string;
  sys: VmSystem;
  accounts: Map<string, { uid: number; gid: number; home: string }>;
  cleanup: () => void;
}

const bootstrap = join(__dirname, '../../../../host-bootstrap');
const loadBootstrap = createRequire(__filename);
const { fakeSystem, snapshot } = loadBootstrap(join(bootstrap, 'test/helpers')) as {
  fakeSystem: (options: { rootParent: string }) => FakeSystem;
  snapshot: (file: string) => unknown;
};
const { createInstanceSystem } = loadBootstrap(join(bootstrap, 'lib/system')) as {
  createInstanceSystem: (system: VmSystem, user: string) => VmSystem;
};
const { performClaim, readClaim } = loadBootstrap(join(bootstrap, 'lib/claim')) as {
  performClaim: (claim: unknown, sys: VmSystem, log: () => void) => Promise<ClaimRecord>;
  readClaim: (sys: VmSystem) => ClaimRecord | null;
};
const { validateClaim } = loadBootstrap(join(bootstrap, 'lib/validate')) as {
  validateClaim: (body: unknown, options: { join: unknown }) => unknown;
};
const { reserveJoin, beginJoinClaim, readRegistry, requireReservation } = loadBootstrap(
  join(bootstrap, 'lib/instances'),
) as {
  reserveJoin: (body: unknown, sys: VmSystem) => Promise<Record<string, unknown>>;
  beginJoinClaim: (claim: unknown, sys: VmSystem) => Promise<void>;
  readRegistry: (sys: VmSystem) => Promise<Array<{ claim?: ClaimRecord }>>;
  requireReservation: (sys: VmSystem) => Promise<unknown>;
};
const { requestUpdate, runUpdate } = loadBootstrap(join(bootstrap, 'lib/update')) as {
  requestUpdate: (version: string, sys: VmSystem) => Promise<void>;
  runUpdate: (version: string, sys: VmSystem) => Promise<void>;
};
const { requireHelperInstance } = loadBootstrap(join(bootstrap, 'lib/helper-instance')) as {
  requireHelperInstance: (sys: VmSystem, options: { sudoUser: string }) => Promise<void>;
};

/** Real registry/claim/update code and HTTPS; package/system commands stay at the OS boundary. */
export class SharedVmFixture {
  private readonly fake = fakeSystem({ rootParent: homedir() });
  readonly root = this.fake.root;
  private readonly sys = this.fake.sys;
  private readonly servers = new Map<string, FakeBootstrapServer>();
  private readonly processes = new Map<string, ChildProcess>();
  private readonly uploads = new Map<string, string>();
  private readonly jobs = new Set<string>();
  private uploadSequence = 0;

  async start(): Promise<void> {
    this.sys.now = () => new Date();
    writeFileSync(
      this.sys.paths.manifestFile,
      JSON.stringify({ imageVersion: '1.4.0', npmRegistry: 'https://registry.example/' }),
    );
    const originalRun = this.sys.run;
    this.sys.run = async (command, args, options) => {
      if (command === 'ss') {
        const output = await promisify(execFile)(command, args);
        return { ...output, code: 0 };
      }
      const result = await originalRun(command, args, options);
      if (command === 'npm' && args.at(-1)?.startsWith('devchain-cli@')) {
        const prefix = args.find((arg) => arg.startsWith('--prefix='))!.slice(9);
        const file = join(prefix, 'lib/node_modules/devchain-cli/dist/host-install/pins.json');
        writeFileSync(
          file,
          JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), sharedVmProtocol: 1 }),
        );
      }
      if (command === 'systemctl' && args[0] === 'restart') {
        const user =
          args[1] === this.sys.paths.unitName
            ? 'alice'
            : args[1].replace(/^devchain-user-/, '').replace(/\.service$/, '');
        await this.restartProcess(user);
      }
      return result;
    };
    await performClaim(
      {
        userName: 'alice',
        homePath: this.homePath('alice'),
        version: '0.25.0',
        port: 3000,
        env: {},
        files: [],
      },
      this.sys,
      () => {},
    );
    await this.restartProcess('alice');
  }

  homePath(user: string): string {
    return join(this.root, 'Users', user);
  }

  readonly renderJoin = async (options: Record<string, unknown>): Promise<string> =>
    JSON.stringify(options);

  readonly ssh = {
    connect: async (): Promise<string> => 'SHA256:shared-vm',
    withSession: async <T>(
      _options: unknown,
      use: (session: SshSession) => Promise<T>,
    ): Promise<T> => use(this.session),
  };

  private readonly session: SshSession = {
    fingerprint: 'SHA256:shared-vm',
    uploadTemp: async (text) => {
      const file = `/tmp/devchain-host-install.${++this.uploadSequence}`;
      this.uploads.set(file, text);
      return file;
    },
    exec: async (command) => {
      const reply = (stdout = '', code = 0, stderr = '') => ({ stdout, code, stderr });
      try {
        if (command.includes('__DEVCHAIN_HOST_STATE__'))
          return reply('__DEVCHAIN_HOST_STATE__claimed');
        const file = command.match(/\/tmp\/devchain-host-install\.\d+/)?.[0];
        if (command.includes(' --check')) {
          const options = JSON.parse(this.uploads.get(file!)!) as { homeUser: string };
          const duplicate = (await readRegistry(this.sys)).find(
            ({ claim }) => claim?.userName === options.homeUser,
          )?.claim;
          return duplicate
            ? reply(
                '',
                1,
                JSON.stringify({
                  code: 'INSTANCE_EXISTS',
                  message: `DevChain already runs for ${duplicate.userName} on port ${duplicate.port}. Add it by address.`,
                }),
              )
            : reply('Pre-validation passed.');
        }
        if (command.includes('getent passwd')) return reply('', 2);
        if (command.includes('tls/cert.pem')) return reply(this.certificate);
        const job = command.match(/devchain-host-install-[A-Za-z0-9_-]+/)?.[0];
        if (command.includes('printf finished'))
          return reply(this.jobs.has(job!) ? 'finished' : 'absent');
        if (command.includes('systemd-run')) {
          this.jobs.add(job!);
          return reply();
        }
        if (command.includes('__DEVCHAIN_EXIT__'))
          return reply('helper installed\n__DEVCHAIN_EXIT__0');
        if (command.includes('--reserve-join')) {
          const input = JSON.parse(this.uploads.get(file!)!) as { userName: string };
          const reservation = await reserveJoin(input, this.sys);
          if (!this.servers.has(input.userName))
            await this.startJoinedServer(input.userName, Number(reservation.port));
          return reply(JSON.stringify(reservation));
        }
        return reply();
      } catch (error) {
        const failure = error as { code?: string; message: string };
        return reply(
          '',
          1,
          JSON.stringify({ code: failure.code ?? 'FIXTURE_FAILED', message: failure.message }),
        );
      }
    },
  };

  get certificate(): string {
    return readFileSync(join(this.sys.paths.tlsDir, 'cert.pem'), 'utf8');
  }

  private async startJoinedServer(user: string, port: number): Promise<void> {
    const own = createInstanceSystem(this.sys, user);
    const server = new FakeBootstrapServer({
      claim: async (body) => {
        const claim = validateClaim(body, { join: await requireReservation(own) });
        await beginJoinClaim(claim, own);
        await performClaim(claim, own, () => {});
        const account = this.fake.accounts.get(user)!;
        server.legacyAllocatedIds = { uid: account.uid, gid: account.gid };
        await this.restartProcess(user);
      },
      update: async (version) => {
        await requireHelperInstance(own, { sudoUser: user });
        await requestUpdate(version, own);
        await runUpdate(version, own);
      },
    });
    await server.listen({ port });
    this.servers.set(user, server);
  }

  private async restartProcess(user: string): Promise<void> {
    const previous = this.processes.get(user);
    if (previous && previous.exitCode === null) {
      const exited = once(previous, 'exit');
      previous.kill();
      await exited;
    }
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    await once(child, 'spawn');
    this.processes.set(user, child);
  }

  instanceSnapshot(user: string): { files: unknown[]; pid: number; claim: ClaimRecord | null } {
    const own = createInstanceSystem(this.sys, user);
    const files = [
      own.paths.installRoot,
      own.paths.etcDir,
      join(own.paths.systemdDir, own.paths.unitName),
    ];
    const child = this.processes.get(user)!;
    process.kill(child.pid!, 0);
    return { files: files.map((file) => snapshot(file)), pid: child.pid!, claim: readClaim(own) };
  }

  async close(): Promise<void> {
    for (const server of this.servers.values()) await server.close();
    for (const child of this.processes.values()) {
      if (child.exitCode !== null) continue;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    this.fake.cleanup();
  }
}
