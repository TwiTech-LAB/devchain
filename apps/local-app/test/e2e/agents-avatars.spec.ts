import { test, expect } from '@playwright/test';

test.describe('Agents avatars visual regression', () => {
  test('renders deterministic avatars with fallback', async ({ page }) => {
    const now = '2024-01-01T00:00:00.000Z';

    await page.addInitScript(() => {
      window.localStorage.setItem('devchain:selectedProjectId', 'test-project-1');
    });

    await page.route('**/api/projects', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'test-project-1',
              name: 'Visual Regression Project',
              description: 'Project used for avatar visual regression',
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
        body: JSON.stringify({
          epicsCount: 4,
          agentsCount: 2,
        }),
      });
    });

    await page.route('**/api/agents?**', async (route) => {
      const url = route.request().url();
      if (!url.includes('projectId=test-project-1')) {
        return route.continue();
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'agent-ada',
              projectId: 'test-project-1',
              profileId: 'test-profile-1',
              name: 'Ada Lovelace',
              createdAt: now,
              updatedAt: now,
              profile: {
                id: 'test-profile-1',
                name: 'Claude Default',
                providerId: 'provider-claude',
                promptCount: 8,
                provider: {
                  id: 'provider-claude',
                  name: 'claude',
                },
              },
            },
            {
              id: 'agent-noname',
              projectId: 'test-project-1',
              profileId: 'test-profile-1',
              name: '',
              createdAt: now,
              updatedAt: now,
              profile: {
                id: 'test-profile-1',
                name: 'Claude Default',
                providerId: 'provider-claude',
                promptCount: 8,
                provider: {
                  id: 'provider-claude',
                  name: 'claude',
                },
              },
            },
          ],
          total: 2,
        }),
      });
    });

    await page.goto('/agents');

    await page.waitForResponse((response) => {
      const url = response.url();
      return url.includes('/api/agents') && url.includes('projectId=test-project-1') && response.ok();
    });

    await expect(page.getByRole('heading', { name: 'Project Agents' })).toBeVisible();
    await expect(page.getByText('Ada Lovelace')).toBeVisible();
    await expect(page.getByText('Unnamed agent')).toBeVisible();

    const list = page.locator('[data-testid="agents-list"]');
    await expect(list).toHaveScreenshot('agents-avatars.png', {
      animations: 'disabled',
      caret: 'hide',
    });
  });
});
