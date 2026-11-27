/**
 * A bundled-template upgrade and a template-file import of a connected project: the
 * VM runs each through home's `/r` proxy, and home's mirror learns the result from
 * the pull route.
 * Test layer: two-instance integration. The proxy, the VM write, the live template
 * settings and the pull route only prove themselves together in two booted apps.
 */
import { randomUUID } from 'crypto';
import {
  seedRemoteProject,
  type SeededRemoteProject,
} from '../../common/test/remote-project.fixture';
import {
  startTwoInstances,
  waitForValue,
  type TestInstance,
  type TwoInstances,
} from '../../common/test/two-instance.fixture';
import { UnifiedTemplateService } from '../registry/services/unified-template.service';
import { SettingsService } from '../settings/services/settings.service';
import type { Remote, RemoteOperation } from '../storage/models/domain.models';
import { ensureProvider } from './replica/__fixtures__/replica-seed';

const TEMPLATE_SLUG = 'teams-dev';
const INSTALLED_VERSION = '0.0.1';

interface BundledTemplate {
  _manifest: { slug: string; version: string; [key: string]: unknown };
  agents: Array<{ id: string; name: string; isProjectOwner?: boolean; [key: string]: unknown }>;
  [key: string]: unknown;
}

describe('template upgrade of a connected project', () => {
  let instances: TwoInstances;
  let remote: Remote;
  let seed: SeededRemoteProject;

  const home = (): TestInstance => instances.home;
  const host = (): TestInstance => instances.host;

  async function api<T = unknown>(
    url: string,
    method: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const response = await fetch(url, {
      method,
      ...(body !== undefined && {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as T) : (null as T) };
  }

  async function connectProject(): Promise<void> {
    const started = await api<RemoteOperation>(
      `${home().url}/api/remotes/${remote.id}/attach`,
      'POST',
      { projectId: seed.projectId },
    );
    expect(started.status).toBeLessThan(300);
    await waitForValue(async () => {
      const { body: operation } = await api<RemoteOperation>(
        `${home().url}/api/remotes/operations/${started.body.id}`,
        'GET',
      );
      if (operation.state === 'failed') {
        throw new Error(`attach failed: ${JSON.stringify(operation.steps)}`);
      }
      return operation.state === 'done' ? operation : null;
    }, 20_000);
  }

  const agentNames = (instance: TestInstance): Set<string> =>
    new Set(
      (
        instance.sqlite
          .prepare('SELECT name FROM agents WHERE project_id = ?')
          .all(seed.projectId) as Array<{ name: string }>
      ).map((row) => row.name),
    );

  const homeListedVersion = async (): Promise<string | null> => {
    const { body } = await api<{
      items: Array<{ id: string; templateMetadata: { version: string | null } | null }>;
    }>(`${home().url}/api/projects`, 'GET');
    return (
      body.items.find((project) => project.id === seed.projectId)?.templateMetadata?.version ?? null
    );
  };

  beforeAll(async () => {
    // Intervals far above the test length: only the pull route may move the mirror.
    instances = await startTwoInstances({
      syncIntervalMs: 600_000,
      reconcileIntervalMs: 600_000,
    });
    remote = await instances.registerRemote('vm-1');
    await waitForValue(async () => {
      const { body } = await api<{ items: Array<{ online: boolean }> }>(
        `${home().url}/api/remotes`,
        'GET',
      );
      return body.items[0]?.online === true;
    }, 10_000);
  }, 90_000);

  // Each case gets its own connected project on the shared pair of apps.
  beforeEach(async () => {
    // The seed always names its workspace 'Handoff', and workspace names are unique.
    for (const instance of [home(), host()])
      instance.sqlite
        .prepare("UPDATE project_workspaces SET name = 'Previous ' || id WHERE name = 'Handoff'")
        .run();
    seed = seedRemoteProject(home().sqlite);
    ensureProvider(host().sqlite, 'host-claude', seed.providerName, null);
    await home().app.get(SettingsService).setProjectTemplateMetadata(seed.projectId, {
      templateSlug: TEMPLATE_SLUG,
      source: 'bundled',
      installedVersion: INSTALLED_VERSION,
      registryUrl: null,
      installedAt: new Date().toISOString(),
    });
    await connectProject();
  }, 30_000);

  afterAll(async () => {
    await instances?.close();
  }, 30_000);

  it('upgrades on the VM through the proxy, then shows the new version at home after the pull', async () => {
    const bundled = host().app.get(UnifiedTemplateService).getBundledTemplate(TEMPLATE_SLUG)
      .content as unknown as BundledTemplate;
    const targetVersion = bundled._manifest.version;

    expect(
      host().app.get(SettingsService).getProjectTemplateMetadata(seed.projectId),
    ).toMatchObject({ installedVersion: INSTALLED_VERSION });
    expect(await homeListedVersion()).toBe(INSTALLED_VERSION);

    const upgrade = await api<{ success: boolean; newVersion?: string; error?: string }>(
      `${home().url}/r/${remote.id}/api/projects/${seed.projectId}/upgrade-template`,
      'POST',
      { targetVersion },
    );
    expect(upgrade).toEqual({ status: 200, body: expect.objectContaining({ success: true }) });
    expect(upgrade.body.newVersion).toBe(targetVersion);

    expect(
      host().app.get(SettingsService).getProjectTemplateMetadata(seed.projectId),
    ).toMatchObject({ installedVersion: targetVersion });
    const hostAgentNames = (
      host()
        .sqlite.prepare('SELECT name FROM agents WHERE project_id = ?')
        .all(seed.projectId) as Array<{ name: string }>
    ).map((row) => row.name);
    expect(new Set(hostAgentNames)).toEqual(new Set(bundled.agents.map((agent) => agent.name)));

    // Home's mirror has not moved until it is told to pull.
    expect(await homeListedVersion()).toBe(INSTALLED_VERSION);

    const pull = await api(`${home().url}/api/remotes/bindings/${seed.projectId}/pull`, 'POST');
    expect(pull.status).toBe(200);

    expect(await homeListedVersion()).toBe(targetVersion);
  }, 60_000);

  it('imports a template file on the VM through the proxy, then mirrors it at home after the pull', async () => {
    const bundled = host().app.get(UnifiedTemplateService).getBundledTemplate(TEMPLATE_SLUG)
      .content as unknown as BundledTemplate;
    const [ownerAgent] = bundled.agents;
    // A slug with no bundled template, so the VM records the import as source `registry`.
    const file: BundledTemplate = {
      ...bundled,
      _manifest: { ...bundled._manifest, slug: 'file-import', version: '9.0.0' },
      agents: [
        ...bundled.agents,
        { ...ownerAgent, id: randomUUID(), name: 'File Importer', isProjectOwner: false },
      ],
    };
    const fileAgentNames = new Set(file.agents.map((agent) => agent.name));
    const expectedMetadata = {
      templateSlug: 'file-import',
      installedVersion: '9.0.0',
      source: 'registry',
    };

    const hostSettings = host().app.get(SettingsService);
    expect(hostSettings.getProjectTemplateMetadata(seed.projectId)).not.toMatchObject(
      expectedMetadata,
    );
    expect(agentNames(host())).not.toEqual(fileAgentNames);

    const proxied = `${home().url}/r/${remote.id}/api/projects`;
    // The wizard's configured body: the file plus the providers chosen for it.
    const importBody = { ...file, selectedProviderNames: [seed.providerName] };
    const preview = await api<{ payload: { _manifest: { slug: string; version: string } } }>(
      `${proxied}/setup-preview`,
      'POST',
      { rawContent: file },
    );
    expect(preview).toEqual({
      status: 200,
      body: expect.objectContaining({
        payload: expect.objectContaining({
          _manifest: expect.objectContaining({ slug: 'file-import', version: '9.0.0' }),
        }),
      }),
    });

    const dryRun = await api<{
      dryRun: boolean;
      error?: string;
      readiness: { ready: boolean };
      counts: { toImport: { agents: number } };
    }>(`${proxied}/${seed.projectId}/import?dryRun=true`, 'POST', importBody);
    expect(dryRun.status).toBe(201);
    expect(dryRun.body).toMatchObject({
      dryRun: true,
      readiness: { ready: true },
      counts: { toImport: { agents: file.agents.length } },
    });
    expect(dryRun.body.error).toBeUndefined();

    const commit = await api<{ success: boolean }>(
      `${proxied}/${seed.projectId}/import`,
      'POST',
      importBody,
    );
    expect(commit).toEqual({ status: 201, body: expect.objectContaining({ success: true }) });

    expect(hostSettings.getProjectTemplateMetadata(seed.projectId)).toMatchObject(expectedMetadata);
    expect(agentNames(host())).toEqual(fileAgentNames);

    const pull = await api(`${home().url}/api/remotes/bindings/${seed.projectId}/pull`, 'POST');
    expect(pull.status).toBe(200);

    expect(
      home().app.get(SettingsService).getProjectTemplateMetadata(seed.projectId),
    ).toMatchObject(expectedMetadata);
    expect(agentNames(home())).toEqual(fileAgentNames);
    expect(await homeListedVersion()).toBe('9.0.0');
  }, 60_000);
});
