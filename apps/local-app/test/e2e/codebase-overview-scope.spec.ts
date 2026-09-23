import { test, expect } from '@playwright/test';

const PROJECT_ID = 'test-project-1';
const now = '2024-01-01T00:00:00.000Z';

test.describe('Codebase Overview — retirement', () => {
  let overviewApiRequests: string[];

  test.beforeEach(async ({ page }) => {
    overviewApiRequests = [];

    page.on('request', (request) => {
      if (/\/api\/projects\/[^/]+\/codebase-overview/.test(request.url())) {
        overviewApiRequests.push(request.url());
      }
    });

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

  test('renders the not-found page on /overview', async ({ page }) => {
    await page.goto('/overview');
    await expect(page.getByRole('heading', { name: 'Page Not Found' })).toBeVisible();
    expect(overviewApiRequests).toHaveLength(0);
  });

  test('renders the not-found page on /overview?section=scope', async ({ page }) => {
    await page.goto('/overview?section=scope');
    await expect(page.getByRole('heading', { name: 'Page Not Found' })).toBeVisible();
    expect(overviewApiRequests).toHaveLength(0);
  });
});
