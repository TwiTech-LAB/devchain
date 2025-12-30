import { test, expect } from '@playwright/test';
// Increase timeout for this spec to reduce flakes in CI
test.setTimeout(60_000);

test.describe('Board URL filters — back/forward navigation', () => {
  const now = '2024-01-01T00:00:00.000Z';
  let rootFetchCount = 0;
  let parentFetchCount = 0;

  test.beforeEach(async ({ page }) => {
    // Ensure a selected project exists in localStorage
    await page.addInitScript(() => {
      window.localStorage.setItem('devchain:selectedProjectId', 'test-project-1');
    });

    // Projects list returns the selected project
    await page.route('**/api/projects', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'test-project-1',
              name: 'Project Alpha',
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

    await page.route('**/api/projects/test-project-1/stats', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ epicsCount: 1, agentsCount: 0 }),
      });
    });

    // Statuses for the project
    await page.route('**/api/statuses?projectId=test-project-1', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            { id: 's1', projectId: 'test-project-1', label: 'Todo', color: '#aaa', position: 0, createdAt: now, updatedAt: now },
          ],
        }),
      });
    });

    // Root epics list (top-level epics)
    await page.route('**/api/epics?projectId=test-project-1&limit=1000&type=active', async (route) => {
      rootFetchCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'root-1',
              projectId: 'test-project-1',
              title: 'Epic Root',
              description: null,
              statusId: 's1',
              version: 1,
              parentId: null,
              agentId: null,
              tags: [],
              createdAt: now,
              updatedAt: now,
            },
          ],
        }),
      });
    });

    // Sub-epics for the selected parent
    await page.route('**/api/epics?parentId=root-1', async (route) => {
      parentFetchCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    });

    // Sub-epics counts
    await page.route('**/api/epics/root-1/sub-epics/counts', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ s1: 0 }),
      });
    });

    // Agents list (unused by this test but queried by the page)
    await page.route('**/api/agents?projectId=test-project-1', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
    });
  });

  test('deep link hydration and click/back flow are consistent', async ({ page }) => {
    // Reset counters between phases
    rootFetchCount = 0;
    parentFetchCount = 0;

    // 1) Deep-link hydration first
    await page.goto('/board?p=root-1');

    // Ensure root list fetched, then rely on DOM to confirm hydration
    await expect.poll(async () => rootFetchCount, { timeout: 15000 }).toBeGreaterThan(0);
    await expect.poll(async () => await page.getByTestId('parent-banner').count(), { timeout: 15000 }).toBe(1);

    // 2) Reset to base board then perform click-based push
    await page.goto('/board');
    await expect(page).not.toHaveURL(/\?p=/);
    await expect(page.getByTestId('parent-banner')).toHaveCount(0);

    // ensure initial root fetch happened (poll counter instead of waiting for a specific in-flight response)
    await expect.poll(async () => rootFetchCount, { timeout: 15000 }).toBeGreaterThan(0);

    // Toggle parent via deterministic title test id
    await page.getByTestId('epic-title-root-1').click();
    await expect(page).toHaveURL(/\?p=root-1$/);

    // Wait for all dependent refetches
    await expect.poll(async () => rootFetchCount, { timeout: 10000 }).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => parentFetchCount, { timeout: 10000 }).toBeGreaterThanOrEqual(1);
    // Poll for banner rather than a single-time visibility check
    await expect.poll(async () => await page.getByTestId('parent-banner').count(), { timeout: 10000 }).toBe(1);
    await expect(page.getByRole('button', { name: 'Clear filter' })).toBeVisible();

    // root list refetch should have occurred at least twice (initial + after toggle)
    expect(rootFetchCount).toBeGreaterThanOrEqual(2);

    // 3) Back navigation clears URL and banner
    await page.goBack();
    await expect(page).not.toHaveURL(/\?p=/);
    await expect(page.getByTestId('parent-banner')).toHaveCount(0);
  });
});
