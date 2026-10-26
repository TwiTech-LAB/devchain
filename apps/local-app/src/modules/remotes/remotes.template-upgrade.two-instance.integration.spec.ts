/**
 * A bundled-template upgrade of a connected project: the VM runs it through
 * home's `/r` proxy, and home's mirror learns the new version from the pull route.
 * Test layer: two-instance integration. The proxy, the VM upgrade, the live template
 * settings and the pull route only prove themselves together in two booted apps.
 */
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
  _manifest: { version: string };
  agents: Array<{ name: string }>;
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
    seed = seedRemoteProject(home().sqlite);
    ensureProvider(host().sqlite, 'host-claude', seed.providerName, null);
    await home().app.get(SettingsService).setProjectTemplateMetadata(seed.projectId, {
      templateSlug: TEMPLATE_SLUG,
      source: 'bundled',
      installedVersion: INSTALLED_VERSION,
      registryUrl: null,
      installedAt: new Date().toISOString(),
    });
    remote = await instances.registerRemote('vm-1');
    await waitForValue(async () => {
      const { body } = await api<{ items: Array<{ online: boolean }> }>(
        `${home().url}/api/remotes`,
        'GET',
      );
      return body.items[0]?.online === true;
    }, 10_000);
    await connectProject();
  }, 90_000);

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
});
