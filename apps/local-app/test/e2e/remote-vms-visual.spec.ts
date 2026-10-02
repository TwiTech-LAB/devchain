import { test, expect, type Locator, type Page } from '@playwright/test';

/**
 * Visual and narrow-width lock for the Remote VMs page in the light, dark and
 * ocean palettes.
 *
 * Every API call and the socket are served in the browser: nothing reaches a
 * DevChain server, so the page shows the same VMs, projects, logins and
 * operations on every run. The clock is fixed for the times the page prints.
 */

const NOW = '2026-09-28T10:00:00.000Z';
const VERSION = '0.23.4';

type Theme = 'light' | 'dark' | 'ocean';
const THEMES: Theme[] = ['light', 'dark', 'ocean'];

const STATS = {
  cpuPercent: 37,
  load1: 0.8,
  load5: 0.6,
  memTotalBytes: 8 * 1024 ** 3,
  memUsedBytes: 5 * 1024 ** 3,
  diskTotalBytes: 60 * 1024 ** 3,
  diskUsedBytes: 21 * 1024 ** 3,
  diskAvailBytes: 39 * 1024 ** 3,
  uptimeSec: 86_400,
  sampledAt: NOW,
};

function remote(partial: Record<string, unknown>) {
  return {
    id: 'r-default',
    kind: 'address',
    baseUrl: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: NOW,
    online: false,
    version: null,
    versionMatches: false,
    uid: null,
    gid: null,
    stats: null,
    lastSeenAt: null,
    homePath: null,
    homePathMatches: null,
    lastOperation: null,
    logins: null,
    vmProviderConnectionId: null,
    ...partial,
  };
}

const REMOTES = [
  remote({
    id: 'r-lab',
    name: 'lab-vm',
    baseUrl: 'http://192.168.1.20:3000',
    online: true,
    version: VERSION,
    versionMatches: true,
    uid: 1000,
    gid: 1000,
    stats: STATS,
    lastSeenAt: NOW,
    homePath: '/home/devchain',
    homePathMatches: true,
    docker: { installed: true, userInGroup: true, engineVersion: '27.1', composeVersion: '2.29' },
    cliVersions: { agy: '1.2.3' },
    providerClis: {
      claude: {
        desiredVersion: 'latest',
        installedVersion: '2.1.281',
        state: 'idle',
        error: null,
        checkedAt: NOW,
      },
      codex: {
        desiredVersion: 'latest',
        installedVersion: '0.156.1',
        state: 'installing',
        error: null,
        checkedAt: NOW,
      },
      copilot: {
        desiredVersion: 'latest',
        installedVersion: '1.0.88',
        state: 'failed',
        error: 'npm install @github/copilot: E404',
        checkedAt: NOW,
      },
      opencode: {
        desiredVersion: '1.18.32',
        installedVersion: '1.18.32',
        state: 'idle',
        error: null,
        checkedAt: NOW,
      },
    },
    logins: {
      claude: { choice: 'reuse', entryIds: ['e-claude'] },
      codex: { choice: 'reuse', entryIds: ['e-codex'] },
    },
  }),
  remote({
    id: 'r-old',
    name: 'old-vm',
    baseUrl: 'http://192.168.1.21:3000',
    online: true,
    version: '0.22.1',
    stats: STATS,
    lastSeenAt: NOW,
    homePath: '/home/devchain',
    homePathMatches: true,
    logins: {},
  }),
  remote({
    id: 'r-build',
    name: 'build-vm',
    kind: 'proxmox',
    baseUrl: 'http://192.168.1.30:3000',
    powerState: 'stopped',
    lastSeenAt: '2026-09-27T18:30:00.000Z',
    vmProviderConnectionId: 'pc1',
    vmIdentity: '12345678-1234-1234-1234-123456789abc',
    vmSpec: { cores: 4, memory: 8192, disk: 60 },
    logins: {},
  }),
  remote({ id: 'r-new', name: 'new-vm', baseUrl: 'http://192.168.1.40:3000' }),
];

const WORKSPACES = [
  { id: 'w-main', name: 'Main', isDefault: true, position: 0, projectCount: 3 },
  { id: 'w-side', name: 'Side projects', isDefault: false, position: 1, projectCount: 1 },
].map((workspace) => ({ ...workspace, deviceGrantCount: 0, createdAt: NOW, updatedAt: NOW }));

const PROJECTS = [
  { id: 'p-web', name: 'Web app', workspaceId: 'w-main' },
  { id: 'p-api', name: 'API gateway', workspaceId: 'w-main' },
  { id: 'p-docs', name: 'Docs site', workspaceId: 'w-side' },
  { id: 'p-notes', name: 'Release notes', workspaceId: 'w-main' },
].map((project) => ({
  ...project,
  description: null,
  rootPath: `/home/devchain/src/${project.id}`,
  createdAt: NOW,
  updatedAt: NOW,
}));

const BINDINGS = [
  { projectId: 'p-web', remoteId: 'r-lab', state: 'attaching', hostCursor: null },
  { projectId: 'p-api', remoteId: 'r-lab', state: 'remote', hostCursor: NOW },
  { projectId: 'p-docs', remoteId: 'r-build', state: 'remote', hostCursor: NOW },
];

const STEP = (id: string, label: string, state: string) => ({ id, label, state, error: null });

const RUNNING_CONNECT = {
  id: 'op-connect',
  kind: 'attach',
  remoteId: 'r-lab',
  projectId: 'p-web',
  state: 'running',
  details: {},
  createdAt: '2026-09-28T09:58:00.000Z',
  updatedAt: NOW,
  steps: [
    STEP('preflight', 'Check the VM and the project', 'done'),
    STEP('stop_sessions', 'Stop agent sessions on this PC', 'done'),
    STEP('settle_time', 'Save agent time', 'done'),
    STEP('freeze_home', 'Lock the project on this PC', 'done'),
    STEP('build_replica', 'Build the project copy', 'done'),
    STEP('push_replica', 'Send the project copy to the VM', 'running'),
    STEP('file_sync_initial', 'Sync files to the VM', 'pending'),
    STEP('bind_remote', 'Make the VM the project owner', 'pending'),
    STEP('thaw_host', 'Unlock the project on the VM', 'pending'),
    STEP('start_live_sync', 'Start live sync', 'pending'),
  ],
};

function entry(partial: Record<string, unknown>) {
  return {
    kind: 'static',
    payloadKind: 'env',
    checkedOutRemoteId: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: NOW,
    lastVerifiedAt: null,
    lastWritebackAt: null,
    ...partial,
  };
}

const LOGINS = [
  entry({
    id: 'e-claude',
    provider: 'claude',
    label: 'Main Claude token',
    lastVerifiedAt: '2026-09-27T08:00:00.000Z',
  }),
  entry({
    id: 'e-codex',
    provider: 'codex',
    kind: 'family',
    payloadKind: 'files',
    label: 'Codex team login',
    checkedOutRemoteId: 'r-lab',
    lastVerifiedAt: '2026-09-27T08:00:00.000Z',
    lastWritebackAt: '2026-09-28T09:00:00.000Z',
  }),
  entry({ id: 'e-opencode', provider: 'opencode', label: 'zai-coding-plan' }),
];

const PROXMOX = {
  id: 'pc1',
  kind: 'proxmox',
  name: 'Proxmox lab',
  apiUrl: 'https://pve.lan:8006',
  node: 'pve1',
  pool: 'devchain',
  storage: 'local-lvm',
  imageStorage: 'local',
  bridge: 'vmbr0',
  vmidMin: 100,
  vmidMax: 999999999,
  namePrefix: 'devchain-',
  tag: 'devchain',
  sslFingerprint: 'AB:'.repeat(31) + 'AB',
  caPem: null,
  tokenId: 'devchain@pve!agent',
  createdAt: NOW,
  updatedAt: NOW,
  capabilities: { create: true, destroy: true, powerState: true },
};

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

/** Serves the Remote VMs API; anything else under `/api` gets an empty answer. */
async function installRoutes(page: Page, rejectedKey = false): Promise<void> {
  // Registered first, so every specific route below wins over it.
  await page.route('**/api/**', (route) => route.fulfill(json({ items: [], total: 0 })));
  await page.route('**/health', (route) => route.fulfill(json({ status: 'ok' })));
  // The app shell lists this PC's sessions as a plain array.
  await page.route('**/api/sessions*', (route) => route.fulfill(json([])));

  await page.route('**/api/runtime', (route) =>
    route.fulfill(
      json({
        mode: 'main',
        version: VERSION,
        bootId: 'boot-visual',
        dockerAvailable: true,
        // The Cloud page, and the Remote VMs section in it, show only with this flag.
        features: { cloudUi: true },
        integrationAdmission: { allowed: true, reason: null },
      }),
    ),
  );
  await page.route('**/api/workspaces', (route) => route.fulfill(json(WORKSPACES)));
  await page.route('**/api/projects?*', (route) =>
    route.fulfill(json({ items: PROJECTS, total: PROJECTS.length })),
  );
  await page.route('**/api/remotes', (route) =>
    route.fulfill(
      json({
        items: REMOTES.map((remote) => ({
          ...remote,
          apiKeyRejected: rejectedKey && remote.id === 'r-lab',
        })),
      }),
    ),
  );
  await page.route('**/api/remotes/bindings', (route) => route.fulfill(json({ items: BINDINGS })));
  await page.route('**/api/remotes/operations?*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    const projectId = params.get('projectId');
    const state = params.get('state');
    const items = [RUNNING_CONNECT].filter(
      (operation) =>
        (projectId === null || operation.projectId === projectId) &&
        (state === null || operation.state === state),
    );
    return route.fulfill(json({ items }));
  });
  await page.route('**/api/remotes/*/stats/history', (route) =>
    route.fulfill(json({ intervalMs: 30_000, samples: [STATS] })),
  );
  await page.route('**/api/remotes/readiness', (route) =>
    route.fulfill(
      json({
        syncthing: { ok: true, version: 'v2.0.9', message: null },
        identity: { ok: true, user: 'devchain', homePath: '/home/devchain', message: null },
        docker: { ok: true, message: null },
      }),
    ),
  );
  await page.route('**/api/remotes/host-install/identity', (route) =>
    route.fulfill(json({ user: 'devchain', homePath: '/home/devchain' })),
  );
  await page.route('**/api/remotes/host-install/ssh-keys', (route) =>
    route.fulfill(json({ available: false, reason: 'non_loopback_host' })),
  );
  await page.route('**/api/provider-auth', (route) => route.fulfill(json({ items: LOGINS })));
  await page.route('**/api/vm-providers', (route) =>
    route.fulfill(
      json({
        items: [PROXMOX],
        address: {
          kind: 'address',
          capabilities: { create: false, destroy: false, powerState: false },
        },
      }),
    ),
  );
  await page.route('**/api/vm-providers/pc1/check', (route) =>
    route.fulfill(json({ ok: true, missing: [] })),
  );
  await page.route('**/api/file-sync/projects/*/ignores', (route) =>
    route.fulfill(json({ ignores: ['(?d)node_modules', '(?d)dist', '(?d)coverage'] })),
  );
  await page.route('**/api/file-sync/projects/*/status', (route) =>
    route.fulfill(json({ folders: [] })),
  );
  await page.route('**/api/projects/*/docker/plan', (route) =>
    route.fulfill(json({ message: 'Docker is not running on this PC.' }, 503)),
  );
  await page.route('**/r/*/api/sessions', (route) => route.fulfill(json([])));
  // Unanswered, Disconnect offers no Docker copy-back.
  await page.route('**/api/projects/*/docker/sync-state', (route) =>
    route.fulfill(json({ message: 'Not found' }, 404)),
  );

  // A connected Socket.IO peer that never sends an event.
  await page.routeWebSocket('**/socket.io/**', (socket) => {
    socket.send('0{"sid":"visual","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
    socket.onMessage((message) => {
      if (message === '40') socket.send('40{"sid":"visual-socket"}');
      if (message === '2') socket.send('3');
    });
  });
}

async function openPage(page: Page, theme: Theme, query = '', rejectedKey = false): Promise<void> {
  await page.clock.setFixedTime(new Date(NOW));
  await page.addInitScript(
    ([stored]) => {
      window.localStorage.setItem('devchain:theme', stored as string);
      window.localStorage.setItem('devchain:selectedProjectId', 'p-notes');
    },
    // Light has no theme class of its own: it is `:root` with the classes removed.
    [theme === 'light' ? 'ocean' : theme],
  );
  await installRoutes(page, rejectedKey);
  await page.goto(`/cloud?section=remote-vm${query}`);
  // A drawer opened from the URL hides the page from the accessibility tree.
  // The drawer has its own Overview tab; the page's tab comes first.
  await expect(
    page
      .locator('#cloud-tabpanel')
      .getByRole('tab', { name: 'Overview', includeHidden: true })
      .first(),
  ).toBeVisible();
  if (theme === 'light') {
    await page.evaluate(() => document.documentElement.classList.remove('dark', 'theme-ocean'));
  }
  await expect(page.locator('html')).toHaveClass(
    theme === 'ocean'
      ? /theme-ocean/
      : theme === 'dark'
        ? /(^|\s)dark(\s|$)/
        : /^(?!.*(dark|theme-ocean)).*$/,
  );
}

const SHOT = { animations: 'disabled', caret: 'hide' } as const;

/** Neither the document nor `element` scrolls sideways. */
async function expectNoHorizontalOverflow(page: Page, element?: Locator): Promise<void> {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
  if (element) {
    const own = await element.evaluate((node) => node.scrollWidth - node.clientWidth);
    expect(own).toBeLessThanOrEqual(1);
    const box = await element.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  }
}

test.describe('Remote VMs page — themes and narrow width', () => {
  test.use({ locale: 'en-US', timezoneId: 'Europe/Madrid' });

  for (const theme of THEMES) {
    test.describe(`${theme} desktop`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 2000 });
      });

      test('Overview with attention items', async ({ page }) => {
        await openPage(page, theme);
        const attention = page.getByRole('list', { name: 'Needs attention' });
        await expect(attention.getByText(/old-vm/).first()).toBeVisible();
        await expect(attention.getByText('Copilot CLI on lab-vm failed')).toBeVisible();
        await expect(
          page.getByRole('list', { name: 'Projects' }).getByText('Docs site'),
        ).toBeVisible();
        await expect(page.getByRole('main')).toHaveScreenshot(
          `remote-vms-overview-${theme}.png`,
          SHOT,
        );
      });

      test('Activity dialog with a running Connect', async ({ page }) => {
        await openPage(page, theme);
        await page.getByRole('button', { name: /^Activity/ }).click();
        await page.getByRole('button', { name: /^Connect · Web app/ }).click();
        const detail = page.getByRole('dialog', { name: 'Connect · Web app' });
        await expect(detail.getByText('Send the project copy to the VM')).toBeVisible();
        await expect(detail).toHaveScreenshot(`remote-vms-activity-${theme}.png`, SHOT);
      });

      test('VM details drawer', async ({ page }) => {
        await openPage(page, theme, '&vm=r-lab');
        const drawer = page.getByRole('dialog', { name: 'lab-vm' });
        await expect(drawer.getByText('/home/devchain')).toBeVisible();
        await expect(drawer.getByText('Provider CLIs')).toBeVisible();
        await expect(drawer.getByText('Copilot', { exact: true })).toBeVisible();
        await expect(drawer.getByText('Failed: npm install @github/copilot: E404')).toBeVisible();
        await expect(drawer).toHaveScreenshot(`remote-vms-drawer-${theme}.png`, SHOT);
      });

      test('API key recovery dialog', async ({ page }) => {
        await openPage(page, theme, '', true);
        const attention = page.getByRole('list', { name: 'Needs attention' });
        await expect(attention.getByText(/lab-vm: API key rejected/)).toBeVisible();
        await attention.getByRole('button', { name: 'Enter API key' }).click();
        const dialog = page.getByRole('dialog', { name: 'Enter API key for lab-vm' });
        await expect(dialog.getByLabel('API key')).toHaveValue('');
        await expect(dialog.getByLabel('API key')).toHaveAttribute('type', 'password');
        await expect(dialog).toHaveScreenshot(`remote-vms-api-key-${theme}.png`, SHOT);
      });

      test('Logins tab', async ({ page }) => {
        await openPage(page, theme, '&tab=logins');
        await expect(page.getByRole('listitem', { name: 'Codex team login' })).toBeVisible();
        await expect(page.getByRole('main')).toHaveScreenshot(
          `remote-vms-logins-${theme}.png`,
          SHOT,
        );
      });

      test('VMs tab', async ({ page }) => {
        await openPage(page, theme, '&tab=vms');
        await expect(page.getByRole('button', { name: 'Add VM' })).toBeVisible();
        await expect(
          page.getByRole('list', { name: 'VMs' }).getByRole('listitem', { name: 'lab-vm' }),
        ).toBeVisible();
        await expect(page.getByRole('main')).toHaveScreenshot(
          `remote-vms-vms-tab-${theme}.png`,
          SHOT,
        );
      });

      test('Proxmox tab', async ({ page }) => {
        await openPage(page, theme, '&tab=proxmox');
        await expect(page.getByText('All required Proxmox rights are present.')).toBeVisible();
        await expect(page.getByRole('main')).toHaveScreenshot(
          `remote-vms-proxmox-${theme}.png`,
          SHOT,
        );
      });
    });
  }

  test.describe('390 px', () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
    });

    test('the page and its tabs do not scroll sideways', async ({ page }) => {
      await openPage(page, 'dark');
      await expect(page.getByRole('list', { name: 'VMs' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      for (const tab of ['VMs', 'Logins', 'Proxmox']) {
        await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
        await expectNoHorizontalOverflow(page);
      }
    });

    /** Each opener leaves exactly one new dialog open, named `dialog`. */
    const DIALOGS: Array<{
      name: string;
      query?: string;
      open: (page: Page) => Promise<void>;
      dialog: string | RegExp;
    }> = [
      {
        name: 'Activity',
        open: async (page) => {
          await page.getByRole('button', { name: /^Activity/ }).click();
        },
        dialog: 'Activity',
      },
      {
        name: 'VM details drawer',
        open: async (page) => {
          await page
            .getByRole('list', { name: 'VMs' })
            .getByRole('button', { name: 'lab-vm', exact: true })
            .click();
        },
        dialog: 'lab-vm',
      },
      {
        name: 'Add your own VM',
        query: '&tab=vms',
        open: async (page) => {
          await page.getByRole('button', { name: 'Add VM' }).click();
          await page.getByRole('menuitem', { name: 'Add your own VM' }).click();
        },
        dialog: 'Add your own VM',
      },
      {
        name: 'Connect',
        open: async (page) => {
          await page
            .getByRole('listitem', { name: 'Release notes' })
            .getByRole('button', { name: 'Connect' })
            .click();
        },
        dialog: 'Connect Release notes',
      },
      {
        name: 'Disconnect',
        open: async (page) => {
          await page
            .getByRole('listitem', { name: 'API gateway' })
            .getByRole('button', { name: 'Disconnect' })
            .click();
        },
        dialog: /Disconnect API gateway/,
      },
      {
        name: 'Change logins',
        query: '&tab=vms',
        open: async (page) => {
          await page.getByRole('button', { name: 'More actions for lab-vm' }).click();
          await page.getByRole('menuitem', { name: 'Change logins' }).click();
        },
        dialog: 'Change logins for lab-vm',
      },
      {
        name: 'Remove',
        query: '&tab=vms',
        open: async (page) => {
          await page.getByRole('button', { name: 'More actions for new-vm' }).click();
          await page.getByRole('menuitem', { name: 'Remove' }).click();
        },
        dialog: /new-vm\?/,
      },
      {
        name: 'Add login',
        query: '&tab=logins',
        open: async (page) => {
          await page.getByRole('button', { name: 'Add login' }).click();
        },
        dialog: 'Add login',
      },
      {
        name: 'Add VM',
        query: '&tab=vms',
        open: async (page) => {
          await page.getByRole('button', { name: 'Add VM' }).click();
          await page.getByRole('menuitem', { name: 'Create on Proxmox lab' }).click();
        },
        dialog: 'Add a VM on Proxmox lab',
      },
      {
        name: 'Connect a server',
        query: '&tab=proxmox',
        open: async (page) => {
          await page.getByRole('button', { name: 'Connect a server' }).click();
        },
        dialog: 'Connect a server',
      },
    ];

    for (const entry of DIALOGS) {
      test(`${entry.name} fits the width`, async ({ page }) => {
        await openPage(page, 'dark', entry.query);
        await entry.open(page);
        const dialog = page.getByRole('dialog', { name: entry.dialog });
        await expect(dialog).toBeVisible();
        await expectNoHorizontalOverflow(page, dialog);
      });
    }
  });
});
