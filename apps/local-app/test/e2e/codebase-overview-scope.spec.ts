import { test, expect } from '@playwright/test';

const PROJECT_ID = 'test-project-1';
const now = '2024-01-01T00:00:00.000Z';

function makeDistrict(id: string) {
  return {
    name: id,
    path: `src/${id}`,
    regionId: 'r1',
    regionName: 'src',
    files: 10,
    sourceFileCount: 8,
    supportFileCount: 2,
    hasSourceFiles: true,
    loc: 500,
    churn7d: 2,
    churn30d: 5,
    testCoverageRate: 0.5,
    sourceCoverageMeasured: true,
    complexityAvg: 10,
    inboundWeight: 3,
    outboundWeight: 2,
    blastRadius: 1,
    couplingScore: 5,
    ownershipHHI: 0.6,
    ownershipMeasured: true,
    primaryAuthorName: 'Dev',
    primaryAuthorShare: 0.8,
    primaryAuthorRecentlyActive: true,
    fileTypeBreakdown: { kind: 'extension', counts: { '.ts': 8, '.json': 2 } },
  };
}

function makeSnapshot(signals: object[]) {
  return {
    snapshotId: 's1',
    projectKey: PROJECT_ID,
    name: 'Test Project',
    regions: [{ id: 'r1', path: 'src', name: 'src', totalFiles: 100, totalLOC: 5000 }],
    districts: [],
    dependencies: [],
    hotspots: [],
    activity: [],
    metrics: {
      totalRegions: 1,
      totalDistricts: signals.length,
      totalFiles: 100,
      gitHistoryDaysAvailable: 30,
      shallowHistoryDetected: false,
      dependencyCoverage: null,
      warnings: [],
      excludedAuthorCount: 0,
      scopeConfigHash: 'abc123',
    },
    signals,
    globalContributors: [],
  };
}

test.describe('Codebase Overview — Scope tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('devchain:selectedProjectId', 'test-project-1');
    });

    await page.route('**/api/projects', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: PROJECT_ID,
              name: 'Test Project',
              description: null,
              rootPath: '/tmp/test',
              createdAt: now,
              updatedAt: now,
            },
          ],
          total: 1,
        }),
      });
    });

    await page.route(`**/api/projects/${PROJECT_ID}/stats`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ epicsCount: 0, agentsCount: 0 }),
      });
    });

    await page.route('**/api/agents?**', async (route) => {
      if (!route.request().url().includes(`projectId=${PROJECT_ID}`)) return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    });
  });

  // SKIPPED: /overview is temporarily disabled for this release (see disable epic 276a38af).
  // To re-enable: change test.skip → test, remove the disabled-page assertions below,
  // remove CodebaseOverviewDisabledPage route swap in App.tsx, restore Layout.tsx nav entry.
  test.skip('override → Save → snapshot re-fetches → district removed from Structure', async ({
    page,
  }) => {
    let snapshotFetchCount = 0;

    // First fetch: 'services' district present. Second fetch (after save): no districts.
    await page.route(
      /\/api\/projects\/test-project-1\/codebase-overview$/,
      async (route) => {
        snapshotFetchCount++;
        const signals = snapshotFetchCount === 1 ? [makeDistrict('services')] : [];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(makeSnapshot(signals)),
        });
      },
    );

    // Scope config: GET returns one default entry; PUT echoes success.
    await page.route(
      /\/api\/projects\/test-project-1\/codebase-overview\/scope/,
      async (route) => {
        if (route.request().method() === 'PUT') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              storageMode: 'local-only',
              entries: [
                {
                  folder: 'src/services',
                  purpose: 'excluded',
                  reason: 'user override',
                  origin: 'user',
                },
              ],
            }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            storageMode: 'local-only',
            entries: [
              {
                folder: 'src/services',
                purpose: 'source',
                reason: 'auto-detected',
                origin: 'default',
              },
            ],
          }),
        });
      },
    );

    // Navigate directly to the scope tab
    await page.goto('/overview?section=scope');

    // Wait for the scope table to render
    await expect(
      page.getByRole('table', { name: 'Folder scope configuration' }),
    ).toBeVisible();

    // Change the override for src/services from (auto) to Excluded
    await page.getByRole('combobox', { name: 'Override purpose for src/services' }).click();
    await page.getByRole('option', { name: 'Excluded' }).click();

    // Save triggers PUT then snapshot invalidation
    await page.getByRole('button', { name: 'Save & Re-analyze' }).click();

    // Toast confirms success
    await expect(page.locator('[data-state="open"]').filter({ hasText: 'Scope saved' })).toBeVisible();

    // Wait for the snapshot to be re-fetched after invalidation
    await expect.poll(() => snapshotFetchCount, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

    // Switch to Structure section
    await page.getByRole('tab', { name: /structure/i }).click();

    // With no signals, the structure section shows the empty state
    await expect(page.getByText('No districts analyzed')).toBeVisible();
  });

  test('shows disabled placeholder on /overview during release', async ({ page }) => {
    await page.goto('/overview');
    await expect(
      page.getByRole('heading', { name: /codebase overview is currently disabled/i }),
    ).toBeVisible();
    await expect(page.getByRole('table', { name: 'Folder scope configuration' })).toHaveCount(0);
  });

  test('shows disabled placeholder on /overview?section=scope during release', async ({ page }) => {
    await page.goto('/overview?section=scope');
    await expect(
      page.getByRole('heading', { name: /codebase overview is currently disabled/i }),
    ).toBeVisible();
    await expect(page.getByRole('table', { name: 'Folder scope configuration' })).toHaveCount(0);
  });
});
