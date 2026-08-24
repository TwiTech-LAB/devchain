import { test, expect, type Page } from '@playwright/test';

/**
 * Deterministic visual/responsive lock for the connected ticket workspace.
 *
 * All provider data is served through page.route mocks — the browser never
 * reaches a live provider, and no credentials exist anywhere in this spec.
 * The linked-task route is used as the entry point because it renders the
 * same ExternalTaskDetailDialog full-screen without a Kanban interaction.
 */

const NOW = '2026-08-22T09:00:00.000Z';
const EPIC_ID = 'epic-visual-1';
const TASK_ID = 'task-vis-1';
const WORKSPACE_URL = `/board/clickup/linked/${EPIC_ID}`;

const TASK_TITLE = 'Ship the connected ticket workspace redesign';
const DESCRIPTION = [
  'Make time entry the focal workflow and keep comments in an independent surface.',
  'Long reference token must wrap without horizontal overflow:',
  'feature/connected-ticket-workspace-redesign-verification-token-000123456789',
].join('\n');

const DETAIL = {
  remoteId: TASK_ID,
  remoteKey: 'TASK-9Z1',
  title: TASK_TITLE,
  description: DESCRIPTION,
  descriptionTruncated: false,
  status: {
    remoteId: 'st-progress',
    remoteStatusIds: ['st-progress'],
    name: 'In Progress',
    color: '#8b5cf6',
    category: 'active',
    position: 2,
  },
  dueAt: '2026-08-30T17:00:00.000Z',
  priority: { name: 'High', color: '#ef4444' },
  subtasks: [],
  subtasksTruncated: false,
  taskTotalDurationMs: 12_600_000,
  webUrl: 'https://app.clickup.com/t/8c2q1v9z1',
  location: { scopeKey: 'team-1', workAreaId: 'list-1', workAreaName: 'Design board' },
  allowedStatuses: [
    {
      actionValue: 'In Review',
      remoteId: 'st-review',
      remoteStatusIds: ['st-review'],
      name: 'In Review',
      color: '#f59e0b',
      category: 'active',
      position: 3,
    },
    {
      actionValue: 'Done',
      remoteId: 'st-done',
      remoteStatusIds: ['st-done'],
      name: 'Done',
      color: '#22c55e',
      category: 'completed',
      position: 4,
    },
  ],
  actions: [
    { action: 'change_status', supported: true },
    { action: 'add_comment', supported: true },
    { action: 'log_time', supported: true },
  ],
  linkState: { linked: true, epicId: EPIC_ID },
};

function comment(index: number) {
  const authors = ['Ada Lovelace', 'Grace Hopper', 'John Doe'];
  return {
    remoteId: `comment-${index}`,
    author: { remoteId: `author-${index}`, displayName: authors[index % authors.length] },
    body: `Comment number ${index} on the workspace redesign.`,
    bodyTruncated: false,
    rich: null,
    lookupToken: null,
    owned: false,
    createdAt: new Date(Date.parse('2026-08-20T10:00:00.000Z') - index * 3_600_000).toISOString(),
    updatedAt: null,
  };
}

/** Newest-first provider pages: ten recent comments, then one older page. */
const COMMENTS_PAGE_1 = {
  comments: Array.from({ length: 10 }, (_, position) => comment(position)),
  nextCursor: 'page-2',
};
const COMMENTS_PAGE_2 = {
  comments: [comment(10)],
  nextCursor: null,
};

const RICH_DESCRIPTION_UNSUPPORTED = {
  document: null,
  fingerprint: null,
  supported: false,
  readOnlyReason: 'unsupported_content',
  canEdit: false,
  canDeleteOwnedComments: false,
};

function jsonResponse(body: unknown): {
  status: 200;
  contentType: 'application/json';
  body: string;
} {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

async function installWorkspaceRoutes(page: Page): Promise<{ timeEntryRequests: () => number }> {
  let timeEntryRequests = 0;

  await page.route('**/api/runtime', async (route) => {
    await route.fulfill(
      jsonResponse({
        mode: 'main',
        version: 'test',
        bootId: 'boot-visual-1',
        dockerAvailable: false,
        integrationAdmission: { allowed: true, reason: null },
      }),
    );
  });

  await page.route('**/api/projects', async (route) => {
    await route.fulfill(
      jsonResponse({
        items: [
          {
            id: 'test-project-1',
            name: 'Visual Regression Project',
            description: null,
            rootPath: '/tmp/test',
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        total: 1,
      }),
    );
  });

  await page.route('**/api/projects/test-project-1/stats', async (route) => {
    await route.fulfill(jsonResponse({ epicsCount: 1, agentsCount: 0 }));
  });

  await page.route('**/api/integrations/connections', async (route) => {
    await route.fulfill(
      jsonResponse({
        items: [
          {
            provider: 'clickup',
            connected: true,
            connectionId: 'conn-cu-1',
            generation: 1,
            updatedAt: NOW,
          },
          {
            provider: 'jira',
            connected: false,
            connectionId: null,
            generation: null,
            updatedAt: null,
          },
        ],
      }),
    );
  });

  await page.route(`**/api/epics/${EPIC_ID}/external-sources`, async (route) => {
    await route.fulfill(
      jsonResponse({
        items: [
          {
            provider: 'clickup',
            remoteTaskId: TASK_ID,
            remoteKey: DETAIL.remoteKey,
            title: TASK_TITLE,
            workAreaName: 'Design board',
            statusName: 'In Progress',
            webUrl: DETAIL.webUrl,
            linkedAt: NOW,
          },
        ],
      }),
    );
  });

  await page.route(`**/api/integrations/my-work/clickup/tasks/${TASK_ID}`, async (route) => {
    await route.fulfill(jsonResponse(DETAIL));
  });

  await page.route(
    `**/api/integrations/my-work/clickup/tasks/${TASK_ID}/comments*`,
    async (route) => {
      const secondPage = route.request().url().includes('cursor=page-2');
      await route.fulfill(jsonResponse(secondPage ? COMMENTS_PAGE_2 : COMMENTS_PAGE_1));
    },
  );

  await page.route(
    `**/api/integrations/my-work/clickup/tasks/${TASK_ID}/rich-description`,
    async (route) => {
      await route.fulfill(jsonResponse(RICH_DESCRIPTION_UNSUPPORTED));
    },
  );

  // The history disclosure stays closed in every scenario, so this route
  // exists only to observe that laziness and to keep an accidental request
  // from destabilizing the render.
  await page.route(
    `**/api/integrations/my-work/clickup/tasks/${TASK_ID}/time-entries**`,
    async (route) => {
      timeEntryRequests += 1;
      await route.fulfill(
        jsonResponse({
          windowDays: 30,
          entries: [],
          truncated: false,
          hasRunningTimer: false,
        }),
      );
    },
  );

  return { timeEntryRequests: () => timeEntryRequests };
}

async function openWorkspace(page: Page, theme: 'ocean' | 'dark'): Promise<void> {
  await page.addInitScript(
    ([themeValue]) => {
      window.localStorage.setItem('devchain:theme', themeValue as string);
      window.localStorage.setItem('devchain:selectedProjectId', 'test-project-1');
    },
    [theme],
  );
  const routes = await installWorkspaceRoutes(page);
  await page.goto(WORKSPACE_URL);

  await expect(page.locator('html')).toHaveClass(
    theme === 'ocean' ? /theme-ocean/ : /(^|\s)dark(\s|$)/,
  );
  const dialog = page.getByRole('dialog', { name: TASK_TITLE });
  await expect(dialog).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Description' }).getByText('Long reference token'),
  ).toBeVisible();
  await expect(page.getByText('Comment number 0')).toBeVisible();
  const timeForm = page.getByRole('form', { name: 'Log time' });
  await expect(timeForm).toBeHidden();
  await expect(page.getByRole('heading', { level: 3, name: 'Time tracked' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand Time tracked' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(page.getByLabel('Notify everyone')).toBeVisible();
  await expect(routes.timeEntryRequests()).toBe(0);
}

function dialogLocator(page: Page) {
  return page.getByRole('dialog', { name: TASK_TITLE });
}

/** Both the document and the dialog must stay free of horizontal overflow. */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
  const dialogOverflow = await dialogLocator(page).evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(dialogOverflow).toBeLessThanOrEqual(1);
}

test.describe('External task detail workspace — visual and responsive lock', () => {
  test.use({ locale: 'en-US', timezoneId: 'Europe/Madrid' });

  test('Ocean desktop baseline keeps the two-column workspace stable', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWorkspace(page, 'ocean');

    await expectNoHorizontalOverflow(page);

    await expect(dialogLocator(page)).toHaveScreenshot('external-task-detail-ocean-desktop.png', {
      animations: 'disabled',
      caret: 'hide',
    });
  });

  test('Dark desktop baseline keeps the two-column workspace stable', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWorkspace(page, 'dark');

    await expectNoHorizontalOverflow(page);

    await expect(dialogLocator(page)).toHaveScreenshot('external-task-detail-dark-desktop.png', {
      animations: 'disabled',
      caret: 'hide',
    });
  });

  test('narrow stacked layout stays overflow-free, bounded, and anchored', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openWorkspace(page, 'dark');

    await expectNoHorizontalOverflow(page);

    // The comments history is its own bounded scroll container with real
    // overflow data on narrow screens.
    const history = page.getByRole('region', { name: 'Comments history' });
    const historyMetrics = await history.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(historyMetrics.clientHeight).toBeLessThan(historyMetrics.scrollHeight);

    // The initial view sits on the newest comment.
    await expect
      .poll(async () => history.evaluate((element) => element.scrollTop + element.clientHeight))
      .toBeGreaterThanOrEqual(historyMetrics.scrollHeight - 1);

    // The composer is reachable through the outer dialog scroll, below the
    // main column in the stacked layout.
    const composer = page.getByRole('textbox', { name: 'Comment' });
    await composer.scrollIntoViewIfNeeded();
    await expect(composer).toBeVisible();
    const viewport = page.viewportSize();
    const composerBox = await composer.boundingBox();
    expect(composerBox).not.toBeNull();
    expect(composerBox!.x).toBeGreaterThanOrEqual(0);
    expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(viewport!.width + 1);
    expect(composerBox!.y).toBeGreaterThanOrEqual(0);
    expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(viewport!.height + 1);

    // Loading an older page prepends content and preserves the reading
    // anchor exactly: scrollTop grows by the height added above it. The
    // button is revealed first so the click itself causes no scroll.
    const loadEarlier = page.getByRole('button', { name: 'Load earlier comments' });
    await loadEarlier.scrollIntoViewIfNeeded();
    const before = await history.evaluate((element) => ({
      top: element.scrollTop,
      height: element.scrollHeight,
    }));
    await loadEarlier.click();
    await expect(page.getByText('Comment number 10')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load earlier comments' })).toHaveCount(0);
    const after = await history.evaluate((element) => ({
      top: element.scrollTop,
      height: element.scrollHeight,
    }));
    expect(after.height).toBeGreaterThan(before.height);
    expect(after.top).toBe(before.top + (after.height - before.height));

    await expectNoHorizontalOverflow(page);

    await expect(dialogLocator(page)).toHaveScreenshot('external-task-detail-narrow-stacked.png', {
      animations: 'disabled',
      caret: 'hide',
    });
  });

  test('1024px keeps the 7/3 workspace ratio, wrapping, and overflow bounds', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await openWorkspace(page, 'ocean');

    // Desktop split: the main column and the comments column share the row
    // at the minmax(0,7fr)/minmax(0,3fr) ratio.
    const columns = dialogLocator(page).locator('.grid.min-h-0.flex-1');
    const columnBoxes = await columns.locator(':scope > div.min-w-0').all();
    expect(columnBoxes).toHaveLength(2);
    const [mainBox, commentsBox] = await Promise.all([
      columnBoxes[0].boundingBox(),
      columnBoxes[1].boundingBox(),
    ]);
    expect(mainBox).not.toBeNull();
    expect(commentsBox).not.toBeNull();
    const ratio = mainBox!.width / commentsBox!.width;
    expect(ratio).toBeGreaterThan(7 / 3 - 0.1);
    expect(ratio).toBeLessThan(7 / 3 + 0.1);

    // Long content wraps inside its column instead of overflowing it.
    const description = page
      .getByRole('region', { name: 'Description' })
      .locator('p.whitespace-pre-wrap');
    const descriptionOverflow = await description.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    );
    expect(descriptionOverflow).toBeLessThanOrEqual(1);
    const title = dialogLocator(page).getByRole('heading', { name: TASK_TITLE });
    const titleOverflow = await title.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    );
    expect(titleOverflow).toBeLessThanOrEqual(1);

    await expectNoHorizontalOverflow(page);
  });
});
