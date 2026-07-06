import { test, expect } from '@playwright/test';

/**
 * Smoke coverage for the /chat "Overrides…" dialog (replaces the old nested
 * model-override submenu). All backend endpoints are mocked via page.route so
 * the flow is deterministic and does not require a live provider session.
 *
 * Covered:
 *  - open dialog from the agent context menu,
 *  - set model + effort and save → single PUT carrying
 *    { providerConfigId, modelOverride, effortOverride } + restart toast
 *    (agent is online),
 *  - config-switch reset: switching the provider config rebinds and clears both
 *    selects back to Default.
 */

const PROJECT_ID = 'e2e-overrides-project';
const AGENT_ID = 'agent-ovr';
const PROFILE_ID = 'prof-1';
const NOW = '2024-01-01T00:00:00.000Z';

const AGENT = {
  id: AGENT_ID,
  projectId: PROJECT_ID,
  profileId: PROFILE_ID,
  name: 'Overrides Agent',
  type: 'agent',
  modelOverride: null,
  effortOverride: null,
  providerConfigId: 'cfg-a',
  providerConfig: {
    id: 'cfg-a',
    name: 'Config A',
    providerId: 'prov-claude',
    providerName: 'claude',
    model: null,
    effort: null,
  },
  createdAt: NOW,
  updatedAt: NOW,
};

const PROVIDER_CONFIGS = [
  { id: 'cfg-a', name: 'Config A', providerId: 'prov-claude', providerName: 'claude', model: null, effort: null },
  { id: 'cfg-b', name: 'Config B', providerId: 'prov-codex', providerName: 'codex', model: null, effort: null },
];

async function installRoutes(page: import('@playwright/test').Page) {
  await page.addInitScript((projectId) => {
    window.localStorage.setItem('devchain:selectedProjectId', projectId);
  }, PROJECT_ID);

  await page.route('**/api/runtime', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ mode: 'main', version: '1.0.0' }) }),
  );
  await page.route('**/api/worktrees**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/projects', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          { id: PROJECT_ID, name: 'Overrides Project', description: '', rootPath: '/tmp/ovr', createdAt: NOW, updatedAt: NOW },
        ],
        total: 1,
      }),
    }),
  );
  await page.route('**/api/agents?**', (route) => {
    const url = route.request().url();
    if (!url.includes(`projectId=${PROJECT_ID}`)) return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [AGENT], total: 1, limit: 50, offset: 0 }),
    });
  });
  await page.route('**/api/sessions/agents/presence**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ [AGENT_ID]: { online: true, sessionId: 'sess-1' } }),
    }),
  );
  await page.route('**/api/chat/threads?**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], total: 0, limit: 50, offset: 0 }) }),
  );
  await page.route('**/api/threads?**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/profiles/${PROFILE_ID}/provider-configs`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROVIDER_CONFIGS) }),
  );
  await page.route('**/api/providers/prov-claude/models', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'm1', name: 'anthropic/claude-opus' }]) }),
  );
  await page.route('**/api/providers/prov-claude/efforts', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ efforts: [{ id: 'e1', name: 'high' }], supportsEffort: true, requiresModelForEffort: false }),
    }),
  );
  await page.route('**/api/providers/prov-codex/models', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'm2', name: 'openai/gpt-5' }]) }),
  );
  await page.route('**/api/providers/prov-codex/efforts', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ efforts: [{ id: 'e2', name: 'low' }], supportsEffort: true, requiresModelForEffort: false }),
    }),
  );
}

test.describe('Chat Overrides dialog', () => {
  test('sets model + effort and saves in a single PUT with a restart toast', async ({ page }) => {
    await installRoutes(page);

    let putBody: Record<string, unknown> | null = null;
    await page.route(`**/api/agents/${AGENT_ID}`, async (route) => {
      if (route.request().method() === 'PUT') {
        putBody = route.request().postDataJSON();
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      }
      return route.continue();
    });

    await page.goto('/chat');

    const agentRow = page.getByRole('listitem', { name: /Chat with Overrides Agent/i });
    await expect(agentRow).toBeVisible();
    await agentRow.click({ button: 'right' });

    await page.getByRole('menuitem', { name: /Overrides/ }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Overrides — Overrides Agent')).toBeVisible();

    // Model select
    await dialog.getByLabel('Model').click();
    await page.getByRole('option', { name: 'claude-opus' }).click();

    // Effort select
    await dialog.getByLabel('Reasoning Effort').click();
    await page.getByRole('option', { name: 'high' }).click();

    // Online agent → restart warning surfaces inside the dialog.
    await expect(dialog.getByText(/Restart the session to apply/i)).toBeVisible();

    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => putBody).not.toBeNull();
    expect(putBody).toMatchObject({
      providerConfigId: 'cfg-a',
      modelOverride: 'anthropic/claude-opus',
      effortOverride: 'high',
    });

    // Restart flow toast (identical to the model-override flow).
    await expect(page.getByText(/Restart to apply changes\./i)).toBeVisible();
  });

  test('switching provider config resets model and effort to Default', async ({ page }) => {
    await installRoutes(page);
    await page.route(`**/api/agents/${AGENT_ID}`, (route) => route.continue());

    await page.goto('/chat');

    const agentRow = page.getByRole('listitem', { name: /Chat with Overrides Agent/i });
    await expect(agentRow).toBeVisible();
    await agentRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Overrides/ }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Overrides — Overrides Agent')).toBeVisible();

    // Pick a model on the current config.
    await dialog.getByLabel('Model').click();
    await page.getByRole('option', { name: 'claude-opus' }).click();
    await expect(dialog.getByLabel('Model')).toHaveText(/claude-opus/i);

    // Switch to Config B (a different provider): both selects rebind and reset.
    await dialog.getByLabel('Provider Config').click();
    await page.getByRole('option', { name: 'Config B' }).click();

    await expect(dialog.getByLabel('Model')).toHaveText(/Default/i);
    await expect(dialog.getByLabel('Reasoning Effort')).toHaveText(/Default/i);
  });
});
