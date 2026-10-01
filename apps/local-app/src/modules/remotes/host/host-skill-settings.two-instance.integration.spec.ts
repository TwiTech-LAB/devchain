/** Two-instance integration verifies claimed-host admission, streamed content parsing and actual Nest module wiring. */
import { Readable } from 'node:stream';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import * as tar from 'tar';
import { startTwoInstances, type TwoInstances } from '../../../common/test/two-instance.fixture';
import { HostHelperService } from './host-helper.service';
import { HostSkillSettingsService } from './host-skill-settings.service';
import { SkillSourceLifecycleService } from '../../skills/services/skill-source-lifecycle.service';
import { SkillSourceRegistryService } from '../../skills/services/skill-source-registry.service';
import { BUILT_IN_SKILL_SOURCE_NAMES } from '../../../common/constants/built-in-skill-sources';
import { HOME_SKILL_CONTENT_LIMIT } from './host-skill-content';

const body = {
  revision: 'one',
  communitySources: [],
  localSources: [],
  sourcesEnabled: {},
  projectIds: [],
  projectSourceSwitches: [],
};
describe('Host skill settings HTTP', () => {
  let instances: TwoInstances;
  beforeAll(async () => {
    instances = await startTwoInstances();
    jest.spyOn(instances.home.app.get(HostHelperService), 'isClaimedHost').mockReturnValue(false);
    jest.spyOn(instances.host.app.get(HostHelperService), 'isClaimedHost').mockReturnValue(true);
    jest
      .spyOn(instances.host.app.get(HostSkillSettingsService), 'managedRoot')
      .mockReturnValue(join(instances.rootDir, 'managed-skills'));
  }, 60000);
  afterAll(async () => {
    if (instances) {
      await instances.host.app
        .get(SkillSourceLifecycleService)
        .enqueueExclusiveJob(async () => undefined);
      await instances.close();
    }
    jest.restoreAllMocks();
  });
  const put = (url: string, value: unknown) =>
    fetch(`${url}/api/host/skill-settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
  async function status() {
    return (await fetch(`${instances.host.url}/api/host/skill-settings/status`)).json();
  }
  it('refuses all routes on a plain instance and validates the settings body', async () => {
    expect((await put(instances.home.url, body)).status).toBe(409);
    expect((await fetch(`${instances.home.url}/api/host/skill-settings/status`)).status).toBe(409);
    expect(
      (
        await fetch(
          `${instances.home.url}/api/host/skill-settings/local-sources/local/content?contentHash=h`,
          { method: 'PUT', headers: { 'content-type': 'application/x-tar' }, body: 'bad' },
        )
      ).status,
    ).toBe(409);
    expect((await put(instances.host.url, { revision: 'bad' })).status).toBe(400);
  });
  it('queues settings with 202 and reports the applied revision', async () => {
    expect((await put(instances.host.url, body)).status).toBe(202);
    for (let i = 0; i < 50 && (await status()).pendingRevision; i++)
      await new Promise((resolve) => setImmediate(resolve));
    expect(await status()).toEqual({
      appliedRevision: 'one',
      pendingRevision: null,
      skipped: [],
      needsContent: [],
    });
  });
  it('the live built-in registry equals the shared constant', () => {
    expect(instances.host.app.get(SkillSourceRegistryService).getBuiltInSourceNames()).toEqual(
      Object.values(BUILT_IN_SKILL_SOURCE_NAMES).sort(),
    );
  });
  it('streams gzip tar, replaces copies and imports each version into the catalog, including content uploaded while off', async () => {
    const input = join(instances.rootDir, 'upload-input');
    await fs.mkdir(join(input, 'skills', 'example'), { recursive: true });
    const lifecycle = instances.host.app.get(SkillSourceLifecycleService);
    for (const [index, text] of ['one', 'two', 'new'].entries()) {
      const hash = `hash${index}`;
      const request = {
        ...body,
        revision: hash,
        localSources: [{ name: 'http-local', folderPath: '/home/local', contentHash: hash }],
        sourcesEnabled: { 'http-local': index !== 2 },
      };
      expect((await put(instances.host.url, request)).status).toBe(202);
      for (let i = 0; i < 50 && (await status()).pendingRevision; i++)
        await new Promise((resolve) => setImmediate(resolve));
      const file = join(input, 'skills', 'example', 'SKILL.md');
      await fs.writeFile(file, `---\nname: example\ndescription: Example\n---\n${text}`);
      await fs.utimes(file, 1700000000, 1700000000);
      const chunks: Buffer[] = [];
      for await (const chunk of tar.c({ cwd: input, gzip: true }, ['skills']))
        chunks.push(Buffer.from(chunk));
      const response = await fetch(
        `${instances.host.url}/api/host/skill-settings/local-sources/http-local/content?contentHash=${hash}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/x-tar' },
          body: Buffer.concat(chunks),
        },
      );
      expect(response.status).toBe(200);
      await lifecycle.enqueueExclusiveJob(async () => undefined);
      const content = () =>
        instances.host.sqlite
          .prepare("SELECT instruction_content FROM skills WHERE source = 'http-local'")
          .get();
      if (index === 2) {
        expect(content()).toEqual({ instruction_content: 'two' });
        await put(instances.host.url, {
          ...request,
          revision: 'enabled',
          sourcesEnabled: { 'http-local': true },
        });
        for (let i = 0; i < 50 && (await status()).pendingRevision; i++)
          await new Promise((resolve) => setImmediate(resolve));
        await lifecycle.enqueueExclusiveJob(async () => undefined);
      }
      expect(content()).toEqual({ instruction_content: text });
      expect((await status()).needsContent).toEqual([]);
    }
  }, 20000);
  it('returns 413 for oversized received content and keeps the prior copy', async () => {
    const response = await fetch(
      `${instances.host.url}/api/host/skill-settings/local-sources/http-local/content?contentHash=hash2`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/x-tar' },
        body: Readable.from([Buffer.alloc(HOME_SKILL_CONTENT_LIMIT + 1)]),
        duplex: 'half',
      } as RequestInit,
    );
    expect(response.status).toBe(413);
    expect(
      await fs.readFile(
        join(instances.rootDir, 'managed-skills', 'http-local', '.devchain-content-hash'),
        'utf8',
      ),
    ).toBe('hash2');
  });
});
