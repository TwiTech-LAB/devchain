import { Test } from '@nestjs/testing';
import { ProcessExecutorModule } from '../../terminal/services/process-executor/process-executor.module';
// Connect's Docker steps between two real engines: home is this machine's engine,
// the VM is scripts/remote-proofs/docker-import-target.ts reached over the LAN.
// Opt in with DOCKER_IMPORT_TARGET_URL and DOCKER_IMPORT_TARGET_SSH; setup and
// cleanup of both machines: scripts/remote-proofs/docker-import-external.md.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { DockerArchiveJournal } from '../../core/controllers/docker-archive-journal';
import type { RemoteOperation } from '../../storage/models/domain.models';
import type { DockerImportInventory } from '../operations/docker-import-inventory.store';
import { RemoteHostClient } from '../operations/remote-host.client';
import type { RemoteOperationStepRun } from '../operations/remote-operation.types';
import { DockerHandoff } from './docker-handoff';
import { DockerCopyBack } from './docker-copy-back';
import { DockerHandoffStore } from './docker-handoff.store';
import type { DockerSelection, DockerTransferDetails } from './docker-plan.dto';
import { DockerPlanService } from './docker-plan.service';
import { DockerPlanSourceService } from './docker-plan-source.service';
import { fixtureTls } from '../../../common/test/tls-fixture';

const TARGET_URL = process.env.DOCKER_IMPORT_TARGET_URL;
const TARGET_SSH = process.env.DOCKER_IMPORT_TARGET_SSH;
/** Each throttled transfer lasts at least this long; above 300 s proves no header or body timeout. */
const THROTTLE_SECONDS = Number(process.env.DOCKER_IMPORT_THROTTLE_SECONDS ?? 310);
const suite = TARGET_URL && TARGET_SSH ? describe : describe.skip;

const PROJECT = randomUUID();
const REMOTE = randomUUID();
const prefix = `dc-import-${PROJECT.slice(0, 8)}`;
const TEST_LABEL = `dev.devchain.test=${prefix}`;
const OWNER = 'dev.devchain.project';
const fixture = join(homedir(), `.${prefix}`);
const root = join(fixture, 'project');
// The db's data folder, nested in the app's whole-project bind.
const pg = join(root, 'data', 'pg');
const image = `${prefix}:offline`;
const variantImage = `${prefix}:other-config`;
const composeDb = `${prefix}-db-1`;
const runName = `${prefix}-run`;
const appName = `${prefix}-app`;
const rmName = `${prefix}-rm`;
const dbVolume = `${prefix}_db`;
const runNamed = `${prefix}-run-named`;
const rmNamed = `${prefix}-rm-named`;
const network = `${prefix}_default`;
// Env reaches the engines only; the leak checks look for the value itself.
const AUTH_ENV = 'POSTGRES_HOST_AUTH_METHOD=trust';

type Side = 'home' | 'vm';
const quote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`;
function exec(side: Side, args: string[], input?: string): Promise<string> {
  const [command, argv] =
    side === 'home'
      ? [args[0], args.slice(1)]
      : ['ssh', ['-o', 'BatchMode=yes', TARGET_SSH!, args.map(quote).join(' ')]];
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      argv,
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(`${side}: ${args.slice(0, 3).join(' ')} failed: ${stderr.trim()}`))
          : resolve(stdout.trim()),
    );
    if (input !== undefined) child.stdin!.end(input);
  });
}
const docker = (side: Side, ...args: string[]) => exec(side, ['docker', ...args]);
const lines = (output: string) => output.split('\n').filter(Boolean);
async function inspect<T = Record<string, unknown>>(side: Side, name: string): Promise<T> {
  return JSON.parse(await docker(side, 'inspect', name))[0] as T;
}
async function exists(side: Side, kind: 'container' | 'volume', name: string): Promise<boolean> {
  return docker(side, kind, 'inspect', name).then(
    () => true,
    () => false,
  );
}
async function waitPostgres(side: Side, name: string): Promise<void> {
  for (let i = 0; i < 240; i++) {
    const ready = await docker(
      side,
      'exec',
      name,
      'pg_isready',
      '-h',
      '127.0.0.1',
      '-U',
      'postgres',
    )
      .then(() => true)
      .catch(() => false);
    if (ready) return;
    await sleep(250);
  }
  throw new Error(`${side}: ${name} did not become ready`);
}
const sql = (side: Side, name: string, query: string) =>
  docker(side, 'exec', name, 'psql', '-U', 'postgres', '-tAc', query);
const composeArgs = ['compose', '-f', join(root, 'compose.yaml')];

interface EngineInventory {
  containers: string[];
  volumes: string[];
  networks: string[];
  images: string[];
}
async function engineInventory(side: Side): Promise<EngineInventory> {
  return {
    containers: lines(await docker(side, 'ps', '-aq', '--no-trunc')).sort(),
    volumes: lines(await docker(side, 'volume', 'ls', '-q')).sort(),
    networks: lines(
      await docker(side, 'network', 'ls', '-q', '--no-trunc', '--filter', 'type=custom'),
    ).sort(),
    images: lines(await docker(side, 'image', 'ls', '-q', '--no-trunc')).sort(),
  };
}

/** Streams at a steady rate so that `expectedBytes` take `seconds`, and never ends sooner. */
function paced(source: Readable, seconds: number, expectedBytes: number): Readable {
  const started = Date.now();
  const rate = Math.max(1, expectedBytes / seconds);
  let sent = 0;
  async function* pace() {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      for (let offset = 0; offset < chunk.length; offset += 64 * 1024) {
        const part = chunk.subarray(offset, offset + 64 * 1024);
        const due = started + (sent / rate) * 1000 - Date.now();
        if (due > 0) await sleep(due);
        sent += part.length;
        yield part;
      }
    }
    const remaining = started + seconds * 1000 - Date.now();
    if (remaining > 0) await sleep(remaining);
  }
  return Readable.from(pace(), { objectMode: false });
}

// Exact identities of everything the spec or the product creates (rule 11).
const created: Record<Side, EngineInventory> = {
  home: { containers: [], volumes: [], networks: [], images: [] },
  vm: { containers: [], volumes: [], networks: [], images: [] },
};
const baseline: Partial<Record<Side, EngineInventory>> = {};
const remember = (side: Side, kind: keyof EngineInventory, id: string) => {
  if (!created[side][kind].includes(id)) created[side][kind].push(id);
};
async function rememberMounts(side: Side, container: string): Promise<void> {
  const inspected = await inspect<{ Id: string; Mounts: Array<{ Type: string; Name?: string }> }>(
    side,
    container,
  );
  remember(side, 'containers', inspected.Id);
  for (const mount of inspected.Mounts)
    if (mount.Type === 'volume' && mount.Name) remember(side, 'volumes', mount.Name);
}

let scratch: string;
let client: RemoteHostClient;
let store: DockerHandoffStore;
let journal: DockerArchiveJournal;
let handoff: DockerHandoff;
let copyBack: DockerCopyBack;
const inventory = new Map<string, DockerImportInventory>();
const exclusions = new Map<string, string[]>();
const evidence: Record<string, unknown> = {};

function operation(id: string, steps: Record<string, string> = {}): RemoteOperation {
  return {
    id,
    kind: 'attach',
    remoteId: REMOTE,
    projectId: PROJECT,
    state: 'running',
    steps: Object.entries(steps).map(([step, state]) => ({ id: step, state })),
    details: {},
  } as unknown as RemoteOperation;
}
function runner(
  id: string,
  selection: DockerSelection,
  onProgress?: (docker: DockerTransferDetails) => void,
) {
  const details: Record<string, unknown> = { dockerSelection: selection };
  const progress: Array<Record<string, unknown>> = [];
  const run = (): RemoteOperationStepRun => ({
    operation: operation(id),
    details,
    progress: async (patch) => {
      progress.push(structuredClone(patch));
      Object.assign(details, patch);
      if (patch.docker) onProgress?.(patch.docker as DockerTransferDetails);
    },
  });
  return { details, progress, run };
}
async function connect(r: ReturnType<typeof runner>): Promise<void> {
  await handoff.preflight(r.run());
  await handoff.stopHome(r.run());
  await handoff.push(r.run());
  await handoff.createHost(r.run());
}
async function homeIds(): Promise<{ db: string; run: string; rm: string; app: string }> {
  const id = (name: string) => docker('home', 'inspect', '-f', '{{.Id}}', name);
  return {
    db: await id(composeDb),
    run: await id(runName),
    rm: await id(rmName),
    app: await id(appName),
  };
}
async function stateOf(side: Side, name: string): Promise<string> {
  return docker(side, 'inspect', '-f', '{{.State.Status}}', name);
}
/** The agent on the VM: Compose brings its service up, `docker start` the run container. */
async function agentStartsVm(): Promise<void> {
  await docker('vm', ...composeArgs, 'up', '-d');
  await docker('vm', 'start', runName);
  await waitPostgres('vm', composeDb);
  await waitPostgres('vm', runName);
}
async function stopVm(): Promise<void> {
  // Disconnect's product stop, then the agent's own Compose-created holder.
  await client.dockerStopProject(REMOTE, PROJECT);
  for (const name of [composeDb, runName])
    if (await exists('vm', 'container', name)) await docker('vm', 'stop', '-t', '10', name);
}
function expectNoEnv(value: unknown): void {
  expect(JSON.stringify(value).includes(AUTH_ENV)).toBe(false);
  expect(JSON.stringify(value).includes('HOST_AUTH_METHOD')).toBe(false);
}

suite('Docker import across two real engines', () => {
  jest.setTimeout(45 * 60_000);

  beforeAll(async () => {
    baseline.home = await engineInventory('home');
    baseline.vm = await engineInventory('vm');
    const vmImageStore = await docker('vm', 'info', '--format', '{{json .DriverStatus}}');
    evidence.engines = {
      home: await docker(
        'home',
        'version',
        '--format',
        '{{.Server.Version}} api {{.Server.APIVersion}}',
      ),
      vm: await docker(
        'vm',
        'version',
        '--format',
        '{{.Server.Version}} api {{.Server.APIVersion}}',
      ),
      composeHome: await docker('home', 'compose', 'version', '--short'),
      composeVm: await docker('vm', 'compose', 'version', '--short'),
      vmImageStore,
    };
    expect(vmImageStore).toContain('io.containerd.snapshotter.v1');

    scratch = await mkdtemp(join(tmpdir(), `${prefix}-`));
    client = new RemoteHostClient(
      {
        getRemote: async () => ({
          id: REMOTE,
          baseUrl: TARGET_URL,
          tlsCertificate: fixtureTls.cert,
        }),
      } as never,
      { get: async () => null, headers: async () => ({}) } as never,
    );
    const sourceModule = await Test.createTestingModule({
      imports: [ProcessExecutorModule],
      providers: [DockerPlanSourceService],
    }).compile();
    const source = sourceModule.get(DockerPlanSourceService);
    const inventoryStore = {
      get: (p: string, r: string) => inventory.get(`${p}/${r}`) ?? null,
      set: (p: string, r: string, value: DockerImportInventory) => {
        inventory.set(`${p}/${r}`, value);
        return value;
      },
    };
    const plans = new DockerPlanService(
      {
        getProject: async () => ({ id: PROJECT, rootPath: root }),
        getRemote: async () => ({
          id: REMOTE,
          baseUrl: TARGET_URL,
          tlsCertificate: fixtureTls.cert,
        }),
      } as never,
      source,
      client,
      inventoryStore as never,
      { get: () => null } as never,
    );
    store = new DockerHandoffStore(scratch);
    journal = new DockerArchiveJournal(scratch);
    handoff = new DockerHandoff(
      plans,
      source,
      client,
      store,
      journal,
      {
        set: (p: string, patterns: string[] | null) => exclusions.set(p, patterns ?? []),
        get: (p: string) => exclusions.get(p) ?? [],
      } as never,
      inventoryStore as never,
      { recordPlan: () => undefined } as never,
    );
    copyBack = new DockerCopyBack(
      plans,
      source,
      client,
      store,
      journal,
      inventoryStore as never,
      { getState: () => ({ online: true, versionMatches: true, apiKeyRejected: false }) } as never,
    );

    // An offline image with a marker, committed rather than built so no build cache remains.
    const seed = `${prefix}-seed`;
    await docker(
      'home',
      'create',
      '--name',
      seed,
      '--entrypoint',
      'sh',
      'postgres:17-alpine',
      '-c',
      'echo built offline > /offline-marker',
    );
    await docker('home', 'start', '-a', seed);
    await docker(
      'home',
      'commit',
      '--change',
      'ENTRYPOINT ["docker-entrypoint.sh"]',
      '--change',
      'CMD ["postgres"]',
      '--change',
      `LABEL ${TEST_LABEL}`,
      seed,
      image,
    );
    await docker(
      'home',
      'commit',
      '--change',
      'ENTRYPOINT ["docker-entrypoint.sh"]',
      '--change',
      'CMD ["postgres"]',
      '--change',
      `LABEL ${TEST_LABEL}`,
      '--change',
      'LABEL dev.devchain.proof.config=second',
      seed,
      variantImage,
    );
    await docker('home', 'rm', '-v', seed);
    remember('home', 'images', await docker('home', 'image', 'inspect', '-f', '{{.Id}}', image));
    remember(
      'home',
      'images',
      await docker('home', 'image', 'inspect', '-f', '{{.Id}}', variantImage),
    );

    // File sync would carry the project folder and its Compose file to the VM.
    const compose = {
      name: prefix,
      services: {
        db: {
          image,
          environment: [AUTH_ENV],
          labels: [TEST_LABEL],
          volumes: [`db:/var/lib/postgresql/data`, '/anon', `${pg}:/bind`],
        },
      },
      volumes: { db: { labels: [TEST_LABEL] } },
      networks: { default: { labels: [TEST_LABEL] } },
    };
    await mkdir(pg, { recursive: true });
    // Code only file sync carries; the Docker import must never copy it.
    await writeFile(join(root, 'home-only-code.txt'), 'code');
    await writeFile(join(root, 'compose.yaml'), JSON.stringify(compose, null, 2));
    await exec('vm', ['mkdir', '-p', root]);
    await exec('vm', ['tee', join(root, 'compose.yaml')], JSON.stringify(compose, null, 2));
    // The SSH login may differ from the harness's matching-id runtime user.
    await exec('vm', [
      'sudo',
      '-n',
      'chown',
      '-R',
      `${process.getuid!()}:${process.getgid!()}`,
      fixture,
    ]);

    await docker('home', ...composeArgs, 'up', '-d');
    remember('home', 'networks', network);
    await docker(
      'home',
      'run',
      '-d',
      '--name',
      runName,
      '--label',
      TEST_LABEL,
      '-e',
      AUTH_ENV,
      '-v',
      `${runNamed}:/named`,
      '-v',
      `${pg}:/bind`,
      variantImage,
    );
    await docker(
      'home',
      'run',
      '-d',
      '--rm',
      '--name',
      rmName,
      '--label',
      TEST_LABEL,
      '-v',
      `${rmNamed}:/cache`,
      image,
      'sleep',
      '3600',
    );
    await docker(
      'home',
      'run',
      '-d',
      '--name',
      appName,
      '--label',
      TEST_LABEL,
      '-v',
      `${root}:/app`,
      image,
      'sleep',
      '3600',
    );
    for (const name of [composeDb, runName, rmName, appName]) await rememberMounts('home', name);
    for (const name of [composeDb, runName]) {
      await waitPostgres('home', name);
      await sql(
        'home',
        name,
        "CREATE TABLE proof(value text); INSERT INTO proof VALUES ('home-row');",
      );
    }
    await docker(
      'home',
      'exec',
      composeDb,
      'sh',
      '-c',
      'mkdir -p /bind/nested && echo bind-proof > /bind/nested/file && chown 1234:2345 /bind/nested/file && chmod 640 /bind/nested/file && ln -sf nested/file /bind/link && echo anon-proof > /anon/file',
    );
    await docker('home', 'exec', runName, 'sh', '-c', 'echo named-proof > /named/file');
    await docker('home', 'exec', rmName, 'sh', '-c', 'echo rm-proof > /cache/file');
  });

  afterAll(async () => {
    await cleanup().catch(() => undefined);
    if (scratch) await rm(scratch, { recursive: true, force: true });
    process.stdout.write(`docker-import evidence ${JSON.stringify(evidence)}\n`);
  });

  it('Connect copies Compose, docker run and --rm data and creates the containers stopped, through >300 s transfers', async () => {
    const ids = await homeIds();
    const r = runner(randomUUID(), {
      items: [
        { id: ids.db, mode: 'container-and-data' },
        { id: ids.run, mode: 'container-and-data' },
        { id: ids.rm, mode: 'data-only' },
        { id: ids.app, mode: 'container-and-data' },
      ],
    });
    // The engine answers once it has read the whole content, so the content itself is
    // spread over the window: the saved image's exact size, and the database volume.
    const window = THROTTLE_SECONDS + 20;
    const throttled: Record<string, number> = {};
    const primary = await inspect<{ Id: string; Config: unknown; RootFS: { Layers: string[] } }>(
      'home',
      image,
    );
    const variant = await inspect<{ Id: string; Config: unknown; RootFS: { Layers: string[] } }>(
      'home',
      variantImage,
    );
    expect(variant.Id).not.toBe(primary.Id);
    expect(variant.Config).not.toEqual(primary.Config);
    expect(variant.RootFS.Layers).toEqual(primary.RootFS.Layers);
    const load = client.dockerLoadImage.bind(client);
    const write = client.dockerWriteArchive.bind(client);
    const imageBytes = Number(
      await exec('home', [
        'sh',
        '-c',
        `docker image save ${quote(image)} ${quote(variantImage)} | wc -c`,
      ]),
    );
    const loads = jest
      .spyOn(client, 'dockerLoadImage')
      .mockImplementation(async (remoteId, body, options) => {
        if (throttled.imageLoad !== undefined) return load(remoteId, body, options);
        const started = Date.now();
        throttled.imageLoad = 0;
        const loaded = await load(remoteId, paced(body, window, imageBytes), options);
        throttled.imageLoad = (Date.now() - started) / 1000;
        return loaded;
      });
    jest
      .spyOn(client, 'dockerWriteArchive')
      .mockImplementation(async (remoteId, input, body, options) => {
        if (input.source !== dbVolume) return write(remoteId, input, body, options);
        const planned = (await store.read(r.run().operation.id))!.volumes.find(
          (v) => v.name === dbVolume,
        )!.sizeBytes;
        if (!planned) throw new Error('The plan has no size for the database volume.');
        const started = Date.now();
        const result = await write(remoteId, input, paced(body, window, planned), options);
        throttled.archivePut = (Date.now() - started) / 1000;
        return result;
      });

    await connect(r);
    expect(loads).toHaveBeenCalledTimes(1);
    const loadCount = loads.mock.calls.length;
    jest.restoreAllMocks();
    evidence.throttledSeconds = throttled;
    expect(throttled.imageLoad).toBeGreaterThanOrEqual(THROTTLE_SECONDS);
    expect(throttled.archivePut).toBeGreaterThanOrEqual(THROTTLE_SECONDS);

    // Nothing starts on the VM; the --rm container is not recreated.
    expect(await stateOf('vm', composeDb)).toBe('created');
    expect(await stateOf('vm', runName)).toBe('created');
    expect(await exists('vm', 'container', rmName)).toBe(false);
    for (const name of [composeDb, runName]) await rememberMounts('vm', name);
    for (const name of [dbVolume, runNamed, rmNamed]) {
      expect(await exists('vm', 'volume', name)).toBe(true);
      remember('vm', 'volumes', name);
    }
    remember('vm', 'networks', network);
    remember('vm', 'images', await docker('vm', 'image', 'inspect', '-f', '{{.Id}}', image));
    remember('vm', 'images', await docker('vm', 'image', 'inspect', '-f', '{{.Id}}', variantImage));
    const vmPrimary = await docker('vm', 'image', 'inspect', '-f', '{{.Id}}', image);
    const vmVariant = await docker('vm', 'image', 'inspect', '-f', '{{.Id}}', variantImage);
    expect(vmPrimary).not.toBe(vmVariant);
    expect((await store.read(r.run().operation.id))!.images).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: primary.Id, vmId: vmPrimary }),
        expect.objectContaining({ id: variant.Id, vmId: vmVariant }),
      ]),
    );
    expect((await inspect<{ Image: string }>('vm', composeDb)).Image).toBe(vmPrimary);
    expect((await inspect<{ Image: string }>('vm', runName)).Image).toBe(vmVariant);
    evidence.groupedImages = {
      loads: loadCount,
      home: [primary.Id, variant.Id],
      vm: [vmPrimary, vmVariant],
    };
    expect(
      JSON.parse(await docker('vm', 'volume', 'inspect', '-f', '{{json .Labels}}', dbVolume)),
    ).toMatchObject({ [OWNER]: PROJECT, 'com.docker.compose.project': prefix });
    // The helpers were removed with their own anonymous volumes on both engines.
    for (const side of ['home', 'vm'] as const)
      expect(lines(await docker(side, 'ps', '-aq', '--filter', 'name=devchain-archive'))).toEqual(
        [],
      );
    expect(await journal.hasPending()).toBe(false);

    // Home: the selected containers are stopped; Docker removed the --rm one.
    expect(await stateOf('home', composeDb)).toBe('exited');
    expect(await stateOf('home', runName)).toBe('exited');
    expect(await exists('home', 'container', rmName)).toBe(false);
    // The whole-project bind is code for file sync; the nested pg folder is Docker data.
    expect(exclusions.get(PROJECT)).toEqual(['/data/pg']);
    expect((await store.read(r.run().operation.id))!.binds).toEqual([
      expect.objectContaining({ path: pg, replace: true }),
    ]);
    expect(await stateOf('vm', appName)).toBe('created');
    expect(await stateOf('home', appName)).toBe('exited');
    await rememberMounts('vm', appName);
    await expect(exec('vm', ['test', '!', '-e', join(root, 'home-only-code.txt')])).resolves.toBe(
      '',
    );
    expectNoEnv([r.details, r.progress, await store.read(r.run().operation.id)]);

    const importedDb = await docker('vm', 'inspect', '-f', '{{.Id}}', composeDb);
    await agentStartsVm();
    // Compose can recreate across stores or versions; the imported data must survive.
    for (const name of [composeDb, runName])
      expect(await sql('vm', name, 'SELECT value FROM proof ORDER BY value')).toBe('home-row');
    expect(await docker('vm', 'exec', composeDb, 'cat', '/anon/file')).toBe('anon-proof');
    expect(await docker('vm', 'exec', runName, 'cat', '/named/file')).toBe('named-proof');
    expect(await docker('vm', 'exec', composeDb, 'cat', '/offline-marker')).toBe('built offline');
    expect(
      await docker('vm', 'exec', composeDb, 'stat', '-c', '%u:%g %a', '/bind/nested/file'),
    ).toBe('1234:2345 640');
    expect(await docker('vm', 'exec', composeDb, 'readlink', '/bind/link')).toBe('nested/file');
    expect(
      await docker(
        'vm',
        'run',
        '--rm',
        '--network',
        'none',
        '-v',
        `${rmNamed}:/cache:ro`,
        image,
        'cat',
        '/cache/file',
      ),
    ).toBe('rm-proof');
    evidence.connect = {
      imported: [composeDb, runName, appName],
      dataOnly: [rmNamed],
      composeRecreated: (await docker('vm', 'inspect', '-f', '{{.Id}}', composeDb)) !== importedDb,
      wholeProjectBind: { excluded: ['/data/pg'], copiedBinds: [pg], rootCopied: false },
    };
  });

  let holder: string;
  it('a cancelled reconnect removes only its own VM items and restarts only what it stopped', async () => {
    // The agent's own Compose container holds the imported volume, with VM-only files.
    await docker('vm', ...composeArgs, 'rm', '-sf', 'db');
    await docker('vm', ...composeArgs, 'up', '-d');
    await waitPostgres('vm', composeDb);
    holder = await docker('vm', 'inspect', '-f', '{{.Id}}', composeDb);
    await rememberMounts('vm', composeDb);
    expect(
      JSON.parse(await docker('vm', 'inspect', '-f', '{{json .Config.Labels}}', composeDb))[OWNER],
    ).toBeUndefined();
    await docker(
      'vm',
      'exec',
      composeDb,
      'sh',
      '-c',
      'echo stale > /var/lib/postgresql/data/vm-only && echo stale > /bind/vm-only',
    );
    await stopVm();
    await docker('home', 'start', composeDb);
    await waitPostgres('home', composeDb);

    const ids = {
      db: await docker('home', 'inspect', '-f', '{{.Id}}', composeDb),
      run: await docker('home', 'inspect', '-f', '{{.Id}}', runName),
    };
    const id = randomUUID();
    let startBytes: number | null = null;
    let cancelledAt: string | null = null;
    const r = runner(
      id,
      {
        items: [
          { id: ids.db, mode: 'container-and-data', dataChoice: 'replace-home' },
          { id: ids.run, mode: 'container-and-data', dataChoice: 'replace-home' },
        ],
      },
      (progress) => {
        if (cancelledAt || progress.item?.phase !== 'volume') return;
        if (startBytes === null) startBytes = progress.bytesDone;
        else if (progress.bytesDone > startBytes) {
          cancelledAt = progress.item.name;
          handoff.interrupt(id);
        }
      },
    );
    await handoff.preflight(r.run());
    expect((r.details.docker as DockerTransferDetails).replaced.length).toBeGreaterThan(0);
    await handoff.stopHome(r.run());
    await expect(handoff.push(r.run())).rejects.toBeDefined();
    expect(cancelledAt).not.toBeNull();
    const record = (await store.read(id))!;
    expect(record.stopped.map((s) => s.id)).toEqual([ids.db]);
    const attempt = [...record.created.volumes];
    expect(attempt.length).toBeGreaterThan(0);

    const result = await handoff.rollback(
      operation(id, { docker_preflight: 'done', docker_stop_home: 'done', docker_push: 'failed' }),
    );
    expect(result).toEqual({});
    for (const name of attempt) expect(await exists('vm', 'volume', name)).toBe(false);
    // A replaced VM copy is not recovered; the plan disclosed this before Connect.
    for (const name of record.replaced) expect(await exists('vm', 'volume', name)).toBe(false);
    expect(await stateOf('home', composeDb)).toBe('running');
    expect(await stateOf('home', runName)).toBe('exited');
    expect(lines(await docker('vm', 'ps', '-aq', '--filter', 'name=devchain-archive'))).toEqual([]);
    expect(await journal.hasPending()).toBe(false);
    expect(await store.read(id)).toBeNull();
    expectNoEnv([r.details, r.progress, result]);
    evidence.cancel = {
      cancelledDuring: cancelledAt,
      attemptVolumesRemoved: attempt,
      notRecovered: record.replaced,
    };
  });

  it('a reconnect replaces VM copies: VM-only files are gone and the Compose holder is removed', async () => {
    const db = await docker('home', 'inspect', '-f', '{{.Id}}', composeDb);
    const run = await docker('home', 'inspect', '-f', '{{.Id}}', runName);
    const r = runner(randomUUID(), {
      items: [
        { id: db, mode: 'container-and-data', dataChoice: 'replace-home' },
        { id: run, mode: 'container-and-data', dataChoice: 'replace-home' },
      ],
    });
    await connect(r);

    expect(await exists('vm', 'container', holder)).toBe(false);
    expect(await stateOf('vm', composeDb)).toBe('created');
    expect(await stateOf('vm', runName)).toBe('created');
    for (const name of [composeDb, runName]) await rememberMounts('vm', name);
    await agentStartsVm();
    for (const name of [composeDb, runName])
      expect(await sql('vm', name, 'SELECT value FROM proof ORDER BY value')).toBe('home-row');
    await expect(
      docker('vm', 'exec', composeDb, 'test', '!', '-e', '/var/lib/postgresql/data/vm-only'),
    ).resolves.toBe('');
    await expect(docker('vm', 'exec', composeDb, 'test', '!', '-e', '/bind/vm-only')).resolves.toBe(
      '',
    );
    expect(await docker('vm', 'exec', composeDb, 'cat', '/bind/nested/file')).toBe('bind-proof');
    expectNoEnv([r.details, r.progress]);
    await stopVm();
    evidence.reconnect = { holderRemoved: true, vmOnlyFilesGone: true, pgFolderReplaced: true };
  });

  // Only real engines expose the image USER override during archive extraction.
  it.each([
    { label: 'named', user: 'postgres' },
    { label: 'numeric', user: '4321' },
  ])(
    'keeps mixed owners and modes to the VM and back with a $label image USER',
    async ({ label, user }) => {
      const name = `${prefix}-owners-${label}`;
      const ownerImage = `${prefix}:owners-${label}`;
      const volume = `${name}-volume`;
      const bind = join(root, `owners-${label}`);
      const uid = process.getuid!();
      const gid = process.getgid!();
      const paths = ['/named', '/bind'];
      const files = ['user', 'root', 'mixed'];
      const metadata = [`${uid}:${gid} 660`, '0:0 644', '1234:2345 660'].join('\n');
      await mkdir(bind, { recursive: true });
      const seed = `${name}-seed`;
      remember('home', 'containers', seed);
      for (const side of ['home', 'vm'] as const) remember(side, 'images', ownerImage);
      await docker('home', 'create', '--name', seed, image);
      await docker(
        'home',
        'commit',
        '--change',
        `USER ${user}`,
        '--change',
        `LABEL ${TEST_LABEL}`,
        seed,
        ownerImage,
      );
      await docker('home', 'rm', '-v', seed);
      remember('home', 'volumes', volume);
      await docker('home', 'volume', 'create', '--label', TEST_LABEL, volume);
      remember('home', 'containers', name);
      await docker(
        'home',
        'run',
        '-d',
        '--name',
        name,
        '--label',
        TEST_LABEL,
        '--entrypoint',
        'sleep',
        '-v',
        `${volume}:/named`,
        '-v',
        `${bind}:/bind`,
        ownerImage,
        '3600',
      );
      await rememberMounts('home', name);
      const seedFiles = paths
        .map(
          (path) =>
            `echo home-user > ${path}/user && echo home-root > ${path}/root && echo home-mixed > ${path}/mixed && ` +
            `chown ${uid}:${gid} ${path}/user && chown 0:0 ${path}/root && chown 1234:2345 ${path}/mixed && ` +
            `chmod 660 ${path}/user ${path}/mixed && chmod 644 ${path}/root`,
        )
        .join(' && ');
      await docker('home', 'exec', '--user', '0:0', name, 'sh', '-c', seedFiles);
      const selected = await docker('home', 'inspect', '-f', '{{.Id}}', name);
      const r = runner(randomUUID(), {
        items: [{ id: selected, mode: 'container-and-data', dataChoice: 'replace-home' }],
      });
      await connect(r);
      await rememberMounts('vm', name);
      expect(await docker('vm', 'inspect', '-f', '{{.Config.User}}', name)).toBe(user);
      expect(await stateOf('vm', name)).toBe('created');
      await docker('vm', 'start', name);
      const transferred: Record<string, string> = {};
      for (const path of paths) {
        const entries = files.map((file) => `${path}/${file}`);
        const actual = await docker(
          'vm',
          'exec',
          '--user',
          '0:0',
          name,
          'stat',
          '-c',
          '%u:%g %a',
          ...entries,
        );
        expect(actual).toBe(metadata);
        expect(await docker('vm', 'exec', '--user', '0:0', name, 'cat', ...entries)).toBe(
          'home-user\nhome-root\nhome-mixed',
        );
        transferred[path] = actual;
        // Change the VM data so a return copy cannot pass by leaving home untouched.
        await docker(
          'vm',
          'exec',
          '--user',
          '0:0',
          name,
          'sh',
          '-c',
          `echo vm-user > ${path}/user && echo vm-root > ${path}/root && echo vm-mixed > ${path}/mixed`,
        );
      }
      const sync = await copyBack.syncState(PROJECT, { remoteId: REMOTE });
      expect(sync.availability.available).toBe(true);
      expect(sync.groups.flatMap((group) => group.volumes)).toContain(volume);
      expect(sync.groups.flatMap((group) => group.bindPaths)).toContain(bind);
      const back = runner(randomUUID(), { items: [] });
      back.details.dockerCopyBack = {
        choices: Object.fromEntries(sync.groups.map((group) => [group.key, 'copy-home'])),
      };
      const detach = (): RemoteOperationStepRun => {
        const run = back.run();
        return { ...run, operation: { ...run.operation, kind: 'detach' } };
      };
      await copyBack.copyHome(detach());
      expect(back.details.dockerCopyBackResult).toMatchObject({
        copied: expect.arrayContaining([name]),
      });
      expect(await stateOf('vm', name)).toBe('exited');
      await docker('home', 'start', name);
      const returned: Record<string, string> = {};
      for (const path of paths) {
        const entries = files.map((file) => `${path}/${file}`);
        const actual = await docker(
          'home',
          'exec',
          '--user',
          '0:0',
          name,
          'stat',
          '-c',
          '%u:%g %a',
          ...entries,
        );
        expect(actual).toBe(metadata);
        expect(await docker('home', 'exec', '--user', '0:0', name, 'cat', ...entries)).toBe(
          'vm-user\nvm-root\nvm-mixed',
        );
        returned[path] = actual;
      }
      await docker('home', 'stop', '-t', '1', name);
      expect(await journal.hasPending()).toBe(false);
      evidence[`owners-${label}`] = { user, transferred, returned };
    },
  );

  it('cleanup leaves both engines as they were', async () => {
    await cleanup();
    expect(await engineInventory('home')).toEqual(baseline.home);
    expect(await engineInventory('vm')).toEqual(baseline.vm);
    expect(await journal.hasPending()).toBe(false);
    evidence.cleanup = { home: baseline.home, vm: baseline.vm, removed: created };
  });
});

/** Removes exactly what was recorded, plus VM items that carry this run's labels. */
async function cleanup(): Promise<void> {
  for (const side of ['home', 'vm'] as const) {
    const labelled = lines(
      await docker(side, 'ps', '-aq', '--no-trunc', '--filter', `label=${TEST_LABEL}`).catch(
        () => '',
      ),
    );
    for (const id of labelled) await rememberMounts(side, id).catch(() => undefined);
    for (const id of created[side].containers)
      await docker(side, 'rm', '-f', id).catch(() => undefined);
    const owned = lines(
      await docker(side, 'volume', 'ls', '-q', '--filter', `label=${OWNER}=${PROJECT}`).catch(
        () => '',
      ),
    );
    for (const name of [...created[side].volumes, ...owned])
      await docker(side, 'volume', 'rm', name).catch(() => undefined);
    // This run's unique network and image names, also when a failure preceded recording them.
    for (const name of new Set([...created[side].networks, network]))
      await docker(side, 'network', 'rm', name).catch(() => undefined);
    for (const id of new Set([...created[side].images, image, variantImage]))
      await docker(side, 'image', 'rm', id).catch(() => undefined);
    // `copyUIDGID=false` preserves archive owners, so the fixture needs root to remove.
    await exec(side, ['sudo', '-n', 'rm', '-rf', '--', fixture]).catch(() => undefined);
  }
}
