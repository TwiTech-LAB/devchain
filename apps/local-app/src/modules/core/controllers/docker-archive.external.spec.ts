import { DockerArchiveJournal, type JournaledDockerHelper } from './docker-archive-journal';
// Only a real engine can verify archive ownership, directory headers and image VOLUME side effects.
// Opt in via Jest's external-integration project; use sudo on hosts requiring socket privileges.
import { execFileSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  chown,
  symlink,
  rm,
  link,
  lchown,
  utimes,
  stat,
  open,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID, createHash, type Hash } from 'node:crypto';
import { create, list } from 'tar';
import { pipeline } from 'node:stream/promises';
import { Readable, PassThrough, Transform, Writable } from 'node:stream';
import { DockerEngineClient } from './docker-engine.client';
import { projectDockerCreate, type DockerContainerInspect } from './docker-settings';
import { readDockerArchive, writeDockerArchive } from './docker-archive';
import { DockerArchiveOwnerTransform, type DockerArchiveOwnerIds } from './docker-archive-owners';
import { HostDockerService } from '../../remotes/host/host-docker.service';

jest.setTimeout(60_000);

/** Why a test cannot run here, or null. The suite never pulls an image. */
function blocker(image: string, needsRoot: boolean): string | null {
  if (needsRoot && process.getuid?.() !== 0) return 'run as root; it changes file owners';
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
    return null;
  } catch {
    return `run docker pull ${image}`;
  }
}

/** Runs the test when Docker has the image (and the test runs as root, if needed). */
function withImage(
  image: string,
  needsRoot = false,
): (name: string, fn: jest.ProvidesCallback) => void {
  const reason = blocker(image, needsRoot);
  return reason
    ? (name, fn) => it.skip(`${name} (skipped: ${reason})`, fn)
    : (name, fn) => it(name, fn);
}

const ownerImage = process.env.DOCKER_ARCHIVE_OWNER_IMAGE ?? 'postgres:17-alpine';
withImage(ownerImage, true)(
  'round-trips owners, file/root modes and symlinks without starting helpers or leaking helper volumes',
  async () => {
    const client = await DockerEngineClient.connect();
    const image = ownerImage;
    // Use a cached service image with VOLUME so anonymous-volume ownership is exercised without a pull.
    await client.json('GET', `/images/${encodeURIComponent(image)}/json`);
    const before = await client.json<{ Volumes: Array<{ Name: string }> | null }>(
      'GET',
      '/volumes',
    );
    const existing = (before.Volumes ?? []).map((volume) => volume.Name);
    const prefix = `dc-archive-test-${randomUUID()}`;
    const volumes: string[] = [];
    const helpers: JournaledDockerHelper[] = [];
    const owned: string[] = [];
    const root = await mkdtemp(join(tmpdir(), 'dc-archive-test-'));
    const journal = new DockerArchiveJournal(root);
    try {
      await mkdir(join(root, 'data/nested'), { recursive: true });
      await chmod(join(root, 'data'), 0o700);
      await writeFile(join(root, 'data/nested/file'), 'archive marker\n');
      await chmod(join(root, 'data/nested/file'), 0o640);
      await chown(join(root, 'data/nested'), 1234, 2345);
      await chown(join(root, 'data/nested/file'), 1234, 2345);
      await symlink('nested/file', join(root, 'data/link'));
      for (const suffix of ['source', 'target']) {
        const volume = await client.json<{ Name: string }>('POST', '/volumes/create', {
          Name: `${prefix}-${suffix}`,
          Labels: { 'dev.devchain.test': prefix },
        });
        volumes.push(volume.Name);
        const helper = await journal.create(client, image, [
          { Type: 'volume', Source: volume.Name, Target: '/data' },
        ]);
        helpers.push(helper);
        owned.push(...helper.ownedVolumeIds);
        expect(helper.ownedVolumeIds.length).toBeGreaterThan(0);
        const saved = await client.json<DockerContainerInspect>(
          'GET',
          `/containers/${helper.id}/json`,
        );
        const projected = projectDockerCreate(saved);
        expect(projected.Image === saved.Image).toBe(true);
        expect(projected.HostConfig).toMatchObject({ NetworkMode: 'none' });
      }
      await writeDockerArchive(
        client,
        helpers[0].id,
        Readable.from(create({ cwd: root }, ['data'])),
      );
      await writeDockerArchive(
        client,
        helpers[1].id,
        await readDockerArchive(client, helpers[0].id),
      );
      const entries: Record<
        string,
        { uid?: number; gid?: number; mode?: number; linkpath?: string; content: string }
      > = {};
      await pipeline(
        await readDockerArchive(client, helpers[1].id),
        list({
          onReadEntry(entry) {
            const record = {
              uid: entry.uid,
              gid: entry.gid,
              mode: entry.mode,
              linkpath: entry.linkpath,
              content: '',
            };
            entries[entry.path.replace(/\/$/, '')] = record;
            entry.on('data', (chunk) => (record.content += chunk.toString()));
          },
        }),
      );
      expect(entries.data).toMatchObject({ uid: 0, gid: 0, mode: 0o700 });
      expect(entries['data/nested']).toMatchObject({ uid: 1234, gid: 2345 });
      expect(entries['data/nested/file']).toMatchObject({
        uid: 1234,
        gid: 2345,
        mode: 0o640,
        content: 'archive marker\n',
      });
      expect(entries['data/link']).toMatchObject({ linkpath: 'nested/file' });
      for (const helper of helpers) {
        const inspect = await client.json<{ State: { Status: string } }>(
          'GET',
          `/containers/${helper.id}/json`,
        );
        expect(inspect.State.Status).toBe('created');
        await journal.cleanup(client, helper);
      }
      const after = await client.json<{ Volumes: Array<{ Name: string }> }>('GET', '/volumes');
      const remaining = after.Volumes.map((volume) => volume.Name);
      expect(remaining).toEqual(expect.arrayContaining([...existing, ...volumes]));
      expect(remaining.filter((id) => owned.includes(id))).toEqual([]);
    } finally {
      for (const helper of helpers) await journal.cleanup(client, helper);
      for (const name of volumes)
        await client.json('DELETE', `/volumes/${encodeURIComponent(name)}`);
      expect(await journal.hasPending()).toBe(false);
      await rm(root, { recursive: true, force: true });
    }
  },
);

withImage('alpine:3.22')(
  'keeps an existing empty volume empty over populated image content and preserves it on helper cleanup',
  async () => {
    const client = await DockerEngineClient.connect();
    const image = 'alpine:3.22';
    const imageInfo = await client.json<{ Id: string }>(
      'GET',
      `/images/${encodeURIComponent(image)}/json`,
    );
    const volumeName = `dc-archive-test-${randomUUID()}-empty`;
    const helpers: JournaledDockerHelper[] = [];
    const root = await mkdtemp(join(tmpdir(), 'dc-archive-test-'));
    const journal = new DockerArchiveJournal(root);
    let volumeCreated = false;
    const entriesAt = async (id: string, path: string): Promise<string[]> => {
      const entries: string[] = [];
      await pipeline(
        await client.stream('GET', `/containers/${id}/archive?path=${encodeURIComponent(path)}`),
        list({
          onReadEntry(entry) {
            entries.push(entry.path.replace(/\/$/, ''));
            entry.resume();
          },
        }),
      );
      return entries;
    };
    try {
      await client.json('POST', '/volumes/create', {
        Name: volumeName,
        Labels: { 'dev.devchain.test': volumeName },
      });
      volumeCreated = true;
      const helper = await journal.create(client, imageInfo.Id, [
        { Type: 'volume', Source: volumeName, Target: '/etc' },
      ]);
      helpers.push(helper);
      const reader = await journal.create(client, imageInfo.Id, [
        { Type: 'volume', Source: volumeName, Target: '/data', ReadOnly: true },
      ]);
      helpers.push(reader);
      // The reader's unmounted /etc proves the fixture actually has image content to seed.
      expect(await entriesAt(reader.id, '/etc')).toContain('etc/alpine-release');
      expect(await entriesAt(reader.id, '/data')).toEqual(['data']);
      expect(await entriesAt(helper.id, '/etc')).toEqual(['etc']);
      expect(await entriesAt(reader.id, '/data')).toEqual(['data']);
      for (const item of helpers) {
        const inspected = await client.json<{ State: { Status: string } }>(
          'GET',
          `/containers/${item.id}/json`,
        );
        expect(inspected.State.Status).toBe('created');
        await journal.cleanup(client, item);
      }
      const preserved = await client.json<{ Name: string }>('GET', `/volumes/${volumeName}`);
      expect(preserved.Name).toBe(volumeName);
      const verifier = await journal.create(client, imageInfo.Id, [
        { Type: 'volume', Source: volumeName, Target: '/data', ReadOnly: true },
      ]);
      helpers.push(verifier);
      expect(await entriesAt(verifier.id, '/data')).toEqual(['data']);
    } finally {
      for (const helper of helpers) await journal.cleanup(client, helper);
      if (volumeCreated) await client.json('DELETE', `/volumes/${volumeName}`);
      expect(await journal.hasPending()).toBe(false);
      await rm(root, { recursive: true, force: true });
    }
  },
);

function hashTap(hash: Hash, observe?: (bytes: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      observe?.(chunk.length);
      done(null, chunk);
    },
  });
}

async function archiveDigest(client: DockerEngineClient, helper: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(
    await readDockerArchive(client, helper),
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        done();
      },
    }),
  );
  return hash.digest('hex');
}

interface RestoredEntry {
  uid?: number;
  gid?: number;
  mode?: number;
  mtime?: Date;
  type: string;
  linkpath?: string;
  sha256: string;
}
async function restoredEntries(
  client: DockerEngineClient,
  helper: string,
): Promise<Record<string, RestoredEntry>> {
  const found: Record<string, RestoredEntry> = {};
  await pipeline(
    await readDockerArchive(client, helper),
    list({
      onReadEntry(item) {
        const hash = createHash('sha256');
        const saved: RestoredEntry = {
          uid: item.header.uid,
          gid: item.header.gid,
          mode: item.mode,
          mtime: item.mtime,
          type: item.type,
          linkpath: item.linkpath,
          sha256: '',
        };
        found[item.path.replace(/\/$/, '')] = saved;
        item.on('data', (chunk: Buffer) => hash.update(chunk));
        item.on('end', () => {
          saved.sha256 = hash.digest('hex');
        });
      },
    }),
  );
  return found;
}

const sourceIds = { uid: 1000, gid: 1000 };
const mappingCases = [
  { name: 'uid-only', target: { uid: 1001, gid: 1000 } },
  { name: 'gid-only', target: { uid: 1000, gid: 1002 } },
  { name: 'both', target: { uid: 1001, gid: 1002 } },
] satisfies Array<{ name: string; target: DockerArchiveOwnerIds }>;

for (const { name, target } of mappingCases) {
  withImage(ownerImage, true)(
    `restores ${name} mapped owners to a volume and existing bind root and verifies both digest placements`,
    async () => {
      const client = await DockerEngineClient.connect();
      const root = await mkdtemp(join(homedir(), '.docker-owner-proof-'));
      const journal = new DockerArchiveJournal(join(root, 'journal'));
      const connect = jest.spyOn(DockerEngineClient, 'connect').mockResolvedValue(client);
      const service = new HostDockerService(journal, {} as never);
      const prefix = `dc-owner-proof-${randomUUID()}`;
      const projectId = randomUUID();
      const helpers: JournaledDockerHelper[] = [];
      const volumes: string[] = [];
      const probes: string[] = [];
      const code = join(root, 'code');
      const vmBind = join(root, 'vm-bind');
      const homeBind = join(root, 'home-bind');
      const longName = `long-${'é'.repeat(80)}`;
      const marker = Buffer.from([0, 255, 127, 10, 0, 1]);
      const date = new Date('2020-03-04T05:06:07.000Z');
      const largeMiB = name === 'both' ? Number(process.env.DOCKER_ARCHIVE_PROOF_MIB ?? 256) : 0;
      expect(Number.isSafeInteger(largeMiB) && largeMiB >= 0).toBe(true);
      let peakRss = process.memoryUsage().rss;
      let stage = 'fixture';
      const startingRss = peakRss;
      const sampleRss = () => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      };
      const helper = async (mount: { Type: 'volume' | 'bind'; Source: string }) => {
        const created = await journal.create(client, ownerImage, [{ ...mount, Target: '/data' }]);
        helpers.push(created);
        return created.id;
      };
      const assertOwners = (found: Record<string, RestoredEntry>, ids: DockerArchiveOwnerIds) => {
        expect(found.data).toMatchObject({ ...ids, mode: 0o700 });
        expect(found['data/nested']).toMatchObject({ ...ids, mode: 0o700 });
        expect(found['data/nested/secret']).toMatchObject({ ...ids, mode: 0o600, mtime: date });
        expect(found[`data/${longName}`]).toMatchObject({
          ...ids,
          mode: 0o640,
          mtime: date,
          sha256: createHash('sha256').update(marker).digest('hex'),
        });
        expect(found['data/link']).toMatchObject({
          ...ids,
          mode: 0o777,
          type: 'SymbolicLink',
          linkpath: 'nested/secret',
        });
        expect(found['data/service']).toMatchObject({ uid: 999, gid: 999, mode: 0o640 });
        expect(found['data/root']).toMatchObject({ uid: 0, gid: 0, mode: 0o600 });
        const hardlinks = [found['data/nested/secret'], found['data/hard']];
        expect(hardlinks.map((item) => item.type).sort()).toEqual(['File', 'Link']);
        expect(hardlinks.find((item) => item.type === 'File')?.sha256).toEqual(
          createHash('sha256').update(marker).digest('hex'),
        );
      };
      try {
        await mkdir(code);
        await chown(code, target.uid, target.gid);
        await chmod(code, 0o755);
        await mkdir(join(root, 'data/nested'), { recursive: true });
        const files = ['nested/secret', longName, 'service', 'root', 'already-target', 'mixed'];
        for (const file of files) {
          await writeFile(join(root, 'data', file), marker);
          await chmod(
            join(root, 'data', file),
            file === 'root' || file === 'nested/secret' ? 0o600 : 0o640,
          );
          await chown(join(root, 'data', file), sourceIds.uid, sourceIds.gid);
          await utimes(join(root, 'data', file), date, date);
        }
        await chown(join(root, 'data/service'), 999, 999);
        await chown(join(root, 'data/root'), 0, 0);
        await chown(join(root, 'data/already-target'), target.uid, target.gid);
        await chown(join(root, 'data/mixed'), target.uid, sourceIds.gid);
        await link(join(root, 'data/nested/secret'), join(root, 'data/hard'));
        await symlink('nested/secret', join(root, 'data/link'));
        await lchown(join(root, 'data/link'), sourceIds.uid, sourceIds.gid);
        if (largeMiB) {
          const large = await open(join(root, 'data/large'), 'w');
          try {
            await large.truncate(largeMiB * 1024 * 1024);
          } finally {
            await large.close();
          }
          await chown(join(root, 'data/large'), sourceIds.uid, sourceIds.gid);
          await chmod(join(root, 'data/large'), 0o600);
        }
        for (const path of ['data', 'data/nested']) {
          await chown(join(root, path), sourceIds.uid, sourceIds.gid);
          await chmod(join(root, path), 0o700);
          await utimes(join(root, path), date, date);
        }
        for (const path of [vmBind, homeBind]) {
          await mkdir(path);
          await chown(path, 999, 999);
          await chmod(path, 0o751);
        }
        for (const suffix of ['source', 'vm', 'home']) {
          const created = await client.json<{ Name: string }>('POST', '/volumes/create', {
            Name: `${prefix}-${suffix}`,
            Labels: { 'dev.devchain.project': projectId },
          });
          volumes.push(created.Name);
        }
        const source = await helper({ Type: 'volume', Source: volumes[0] });
        const vmVolume = await helper({ Type: 'volume', Source: volumes[1] });
        const homeVolume = await helper({ Type: 'volume', Source: volumes[2] });
        const vmFolder = await helper({ Type: 'bind', Source: vmBind });
        const homeFolder = await helper({ Type: 'bind', Source: homeBind });
        stage = 'seed-source';
        await writeDockerArchive(
          client,
          source,
          Readable.from(
            create(
              {
                cwd: root,
                maxReadSize: 64 * 1024,
                onWriteEntry(item) {
                  // fs.Stats dates are outside Jest's realm. tar's Date check needs
                  // local Date objects to encode numeric PAX times instead of strings.
                  if (item.stat)
                    for (const key of ['atime', 'ctime', 'mtime'] as const)
                      item.stat[key] = new Date(item.stat[key].getTime());
                },
              },
              ['data'],
            ),
            { objectMode: false },
          ),
        );
        const original = await restoredEntries(client, source);
        assertOwners(original, sourceIds);
        for (const [mountType, vmSource, vmReader, homeReader] of [
          ['volume', volumes[1], vmVolume, homeVolume],
          ['bind', vmBind, vmFolder, homeFolder],
        ] as const) {
          stage = `connect-${mountType}`;
          const sender = createHash('sha256');
          const forward = new DockerArchiveOwnerTransform({ from: sourceIds, to: target });
          const upload = new PassThrough();
          const started = performance.now();
          const sent = pipeline(
            await readDockerArchive(client, source),
            forward,
            hashTap(sender, sampleRss),
            upload,
          );
          const [received] = await Promise.all([
            service.writeArchive(
              { projectId, image: ownerImage, mountType, source: vmSource },
              upload,
            ),
            sent,
          ]);
          const elapsed = performance.now() - started;
          expect(received.sha256).toEqual(sender.digest('hex'));
          expect(forward.result).toEqual({ alreadyTargetEntries: name === 'gid-only' ? 1 : 2 });
          const onVm = await restoredEntries(client, vmReader);
          assertOwners(onVm, target);
          // An application container, separate from the never-started archive helpers, proves actual access.
          const probe = await client.json<{ Id: string }>('POST', '/containers/create', {
            Image: ownerImage,
            User: `${target.uid}:${target.gid}`,
            Entrypoint: ['/bin/sh', '-eu', '-c'],
            Cmd: [
              'cmp /data/nested/secret /data/hard; umask 077; ' +
                'cat /data/nested/secret > /code/readback; ' +
                'printf "vm-created\\n" > /data/vm-created; mkdir /data/vm-created-dir',
            ],
            Labels: { 'dev.devchain.test': prefix },
            HostConfig: {
              ReadonlyRootfs: true,
              NetworkMode: 'none',
              Mounts: [
                { Type: mountType, Source: vmSource, Target: '/data' },
                { Type: 'bind', Source: code, Target: '/code' },
              ],
            },
          });
          probes.push(probe.Id);
          await client.json('POST', `/containers/${probe.Id}/start`);
          expect(
            await client.json<{ StatusCode: number }>(
              'POST',
              `/containers/${probe.Id}/wait?condition=not-running`,
            ),
          ).toMatchObject({ StatusCode: 0 });
          expect(await stat(code)).toMatchObject(target);
          expect((await stat(code)).mode & 0o777).toBe(0o755);
          expect(await stat(join(code, 'readback'))).toMatchObject(target);
          expect((await stat(join(code, 'readback'))).mode & 0o777).toBe(0o600);
          expect(await readFile(join(code, 'readback'))).toEqual(marker);
          const createdOnVm = await restoredEntries(client, vmReader);
          expect(createdOnVm['data/vm-created']).toMatchObject({
            ...target,
            mode: 0o600,
            sha256: createHash('sha256').update('vm-created\n').digest('hex'),
          });
          expect(createdOnVm['data/vm-created-dir']).toMatchObject({ ...target, mode: 0o700 });
          if (largeMiB)
            expect(onVm['data/large']).toMatchObject({
              ...target,
              mode: 0o600,
              sha256: original['data/large'].sha256,
            });
          const expectedRaw = await archiveDigest(client, vmReader);
          stage = `copy-back-${mountType}`;
          const raw = createHash('sha256');
          const mapped = createHash('sha256');
          const backward = new DockerArchiveOwnerTransform({ from: target, to: sourceIds });
          const restored = new PassThrough();
          const returned = pipeline(
            await readDockerArchive(client, vmReader),
            hashTap(raw),
            backward,
            hashTap(mapped, sampleRss),
            restored,
          );
          await Promise.all([writeDockerArchive(client, homeReader, restored), returned]);
          expect(raw.digest('hex')).toEqual(expectedRaw);
          expect(mapped.digest('hex')).not.toEqual(expectedRaw);
          expect(backward.result).toEqual({ alreadyTargetEntries: 0 });
          const atHome = await restoredEntries(client, homeReader);
          assertOwners(atHome, sourceIds);
          expect(atHome['data/vm-created']).toMatchObject({
            ...sourceIds,
            mode: 0o600,
            sha256: createdOnVm['data/vm-created'].sha256,
          });
          expect(atHome['data/vm-created-dir']).toMatchObject({ ...sourceIds, mode: 0o700 });
          if (largeMiB)
            expect(atHome['data/large']).toMatchObject({
              ...sourceIds,
              mode: 0o600,
              sha256: original['data/large'].sha256,
            });
          if (mountType === 'bind') {
            expect(await stat(vmBind)).toMatchObject(target);
            expect((await stat(vmBind)).mode & 0o777).toBe(0o700);
            expect(await stat(homeBind)).toMatchObject(sourceIds);
            expect((await stat(join(vmBind, 'nested/secret'))).ino).toEqual(
              (await stat(join(vmBind, 'hard'))).ino,
            );
            expect((await stat(join(homeBind, 'nested/secret'))).ino).toEqual(
              (await stat(join(homeBind, 'hard'))).ino,
            );
          }
          process.stdout.write(
            `DOCKER_OWNER_PROOF ${JSON.stringify({ case: name, mountType, largeMiB, bytes: received.bytes, connectMiBPerSecond: Number((received.bytes / 1024 / 1024 / (elapsed / 1000)).toFixed(2)), alreadyTargetEntries: forward.result?.alreadyTargetEntries, rssGrowthMiB: Number(((peakRss - startingRss) / 1024 / 1024).toFixed(2)) })}\n`,
          );
        }
        for (const item of helpers) {
          const inspected = await client.json<{ State: { Status: string } }>(
            'GET',
            `/containers/${item.id}/json`,
          );
          expect(inspected.State.Status).toBe('created');
        }
      } catch (error) {
        throw new Error(`Docker owner proof ${name}/${stage} failed`, { cause: error });
      } finally {
        connect.mockRestore();
        for (const id of probes) await client.json('DELETE', `/containers/${id}?force=true&v=true`);
        for (const item of helpers) await journal.cleanup(client, item);
        for (const volume of volumes) await client.json('DELETE', `/volumes/${volume}`);
        expect(await journal.hasPending()).toBe(false);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
