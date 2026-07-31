import { expect, test, type Locator, type Page } from '@playwright/test';
import { EVENT_BUS_ROUTE_DURATION_MS } from '@/ui/components/chat/agent-event-bus/geometry';

// Layer: Playwright browser E2E. A real browser is the cheapest reliable proof
// of bounding-box geometry, scrolling, pointer hit-testing, computed theme
// colors, and live SVG motion because jsdom does not implement those behaviors.
const PROJECT_ID = '55555555-5555-4555-8555-555555555555';
const TEAM_ID = 'event-bus-team';
const NOW = '2024-01-01T00:00:00.000Z';

const AGENTS = [
  {
    id: 'agent-lead',
    projectId: PROJECT_ID,
    profileId: 'profile-1',
    name: 'Epic Manager',
    type: 'agent',
    providerConfigId: null,
    providerConfig: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: 'agent-coder',
    projectId: PROJECT_ID,
    profileId: 'profile-1',
    name: 'Coder',
    type: 'agent',
    providerConfigId: null,
    providerConfig: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: 'agent-reviewer',
    projectId: PROJECT_ID,
    profileId: 'profile-1',
    name: 'Code Reviewer',
    type: 'agent',
    providerConfigId: null,
    providerConfig: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
];

function json(body: unknown) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

async function installRoutes(page: Page) {
  await page.addInitScript(
    ({ projectId, teamId }) => {
      window.localStorage.setItem('devchain:selectedProjectId', projectId);
      window.localStorage.setItem(`devchain:chat:agentTab:${projectId}`, 'teams');
      window.localStorage.setItem(
        'devchain:chatSidebar:teamGroups',
        JSON.stringify({ [teamId]: false }),
      );
      window.localStorage.setItem('devchain:theme', 'dark');
      window.localStorage.removeItem('devchain:chatSidebar:eventBusReduceMotion');
    },
    { projectId: PROJECT_ID, teamId: TEAM_ID },
  );

  await page.route('**/api/runtime', (route) =>
    route.fulfill(json({ mode: 'main', version: '1.0.0' })),
  );
  await page.route('**/api/worktrees**', (route) => route.fulfill(json([])));
  await page.route('**/api/projects', (route) =>
    route.fulfill(
      json({
        items: [
          {
            id: PROJECT_ID,
            name: 'Event Bus Project',
            description: '',
            rootPath: '/tmp/event-bus',
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        total: 1,
      }),
    ),
  );
  await page.route(`**/api/projects/${PROJECT_ID}/presets`, (route) =>
    route.fulfill(json({ presets: [], activePreset: null })),
  );
  await page.route('**/api/agents?**', (route) => {
    if (!route.request().url().includes(`projectId=${PROJECT_ID}`)) {
      return route.continue();
    }
    return route.fulfill(json({ items: AGENTS, total: AGENTS.length, limit: 50, offset: 0 }));
  });
  await page.route('**/api/sessions/agents/presence**', (route) =>
    route.fulfill(
      json({
        'agent-lead': { online: true, sessionId: 'session-lead', activityState: 'idle' },
        'agent-coder': { online: true, sessionId: 'session-coder', activityState: 'idle' },
        'agent-reviewer': {
          online: true,
          sessionId: 'session-reviewer',
          activityState: 'idle',
        },
      }),
    ),
  );
  await page.route('**/api/chat/threads?**', (route) =>
    route.fulfill(json({ items: [], total: 0, limit: 50, offset: 0 })),
  );
  await page.route('**/api/threads?**', (route) => route.fulfill(json({ items: [] })));
  await page.route(`**/api/teams?projectId=${PROJECT_ID}`, (route) =>
    route.fulfill(
      json({
        items: [
          {
            id: TEAM_ID,
            projectId: PROJECT_ID,
            name: 'Builders',
            description: null,
            teamLeadAgentId: 'agent-lead',
            teamLeadAgentName: 'Epic Manager',
            maxMembers: 5,
            maxConcurrentTasks: 3,
            allowTeamLeadCreateAgents: false,
            memberCount: 2,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    ),
  );
  await page.route(`**/api/teams/${TEAM_ID}`, (route) =>
    route.fulfill(
      json({
        id: TEAM_ID,
        projectId: PROJECT_ID,
        name: 'Builders',
        description: null,
        teamLeadAgentId: 'agent-lead',
        teamLeadAgentName: 'Epic Manager',
        maxMembers: 5,
        maxConcurrentTasks: 3,
        allowTeamLeadCreateAgents: false,
        members: [
          { agentId: 'agent-lead', agentName: 'Epic Manager', isLead: true, createdAt: NOW },
          { agentId: 'agent-coder', agentName: 'Coder', isLead: false, createdAt: NOW },
        ],
        profileIds: [],
        profileConfigSelections: [],
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ),
  );
  await page.route('**/api/chat/threads/direct', async (route) => {
    const payload = route.request().postDataJSON() as { projectId: string; agentId: string };
    await route.fulfill(
      json({
        id: `thread-${payload.agentId}`,
        projectId: payload.projectId,
        title: null,
        isGroup: false,
        members: [payload.agentId],
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
  });
}

async function emitEventBusFrame(
  page: Page,
  frame: { type: 'sent' | 'session.starting'; payload: unknown },
) {
  await page.evaluate(
    async ({ projectId, type, payload }) => {
      // @ts-expect-error Vite serves this browser module; the Playwright Node process does not.
      const socketModule: typeof import('../../src/ui/lib/socket') = await import(
        '/src/ui/lib/socket.ts'
      );
      const socket = socketModule.getAppSocket();
      const envelope = {
        topic: `project/${projectId}/agent-messages`,
        type,
        payload,
        ts: new Date().toISOString(),
      };
      for (const listener of socket.listeners('message')) listener(envelope);
      socketModule.releaseAppSocket();
    },
    { projectId: PROJECT_ID, ...frame },
  );
}

type StoryboardPhase = 'launch' | 'mid-flight' | 'arrival';

interface ColorSample {
  r: number;
  g: number;
  b: number;
}

function relativeLuminance({ r, g, b }: ColorSample): number {
  const [red, green, blue] = [r, g, b].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: ColorSample, second: ColorSample): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

class EventBusStoryboard {
  readonly wrapper: Locator;
  readonly overlay: Locator;

  constructor(readonly page: Page) {
    this.wrapper = page.getByTestId('chat-main-agents-wrapper');
    this.overlay = page.getByTestId('agent-event-bus-svg');
  }

  async open(): Promise<void> {
    await installRoutes(this.page);
    await this.page.goto('/chat');
    await expect(this.wrapper).toBeVisible();
    await expect(this.overlay.locator('.agent-event-bus__idle-anchor')).toHaveCount(3);
  }

  async emitNestedTeamMessage(): Promise<void> {
    await emitEventBusFrame(this.page, {
      type: 'sent',
      payload: {
        senderAgentId: 'agent-coder',
        routingKind: 'group',
        teamId: TEAM_ID,
        recipients: [{ agentId: 'agent-reviewer', status: 'delivered' }],
      },
    });
    await expect(this.overlay.locator('[data-route-animation]')).toHaveCount(4);
  }

  async emitContrastRoutes(): Promise<void> {
    await emitEventBusFrame(this.page, {
      type: 'session.starting',
      payload: { agentId: 'agent-coder' },
    });
    await emitEventBusFrame(this.page, {
      type: 'sent',
      payload: {
        senderAgentId: 'agent-lead',
        routingKind: 'direct',
        recipients: [{ agentId: 'agent-coder', status: 'delivered' }],
      },
    });
    await expect(this.overlay.locator('[data-route-animation]')).toHaveCount(8);
    await this.seek('launch');
  }

  async routeDurationMs(): Promise<number> {
    const rawDuration = await this.overlay
      .locator('[data-pulse-role="head"]')
      .getAttribute('data-route-duration');
    const durationMs = Number(rawDuration);
    // Every route shares one duration, taken from the real constant so re-tuning the
    // pacing cannot silently leave this assertion behind.
    expect(durationMs).toBe(EVENT_BUS_ROUTE_DURATION_MS);
    return durationMs;
  }

  async seek(phase: StoryboardPhase): Promise<void> {
    await this.overlay.locator('[data-route-animation]').evaluateAll((elements, nextPhase) => {
      for (const element of elements as SVGElement[]) {
        const animationKind = element.dataset.animationKind;
        const durationMs = Number(element.dataset.routeDuration);
        for (const animation of element.getAnimations()) {
          animation.pause();
          if (animationKind === 'ignition') {
            animation.currentTime = nextPhase === 'launch' ? 72 : 200;
          } else if (animationKind === 'arrival') {
            animation.currentTime = nextPhase === 'arrival' ? 105 : 0;
          } else if (animationKind === 'flight') {
            const progress = nextPhase === 'launch' ? 0.018 : nextPhase === 'mid-flight' ? 0.52 : 1;
            animation.currentTime = durationMs * progress;
          }
        }
      }
    }, phase);
  }

  async screenshot(name: string): Promise<void> {
    await expect(this.wrapper).toHaveScreenshot(name, {
      animations: 'allow',
      caret: 'hide',
    });
  }

  async selectOcean(): Promise<void> {
    await this.page.getByTestId('theme-toggle').click();
    await this.page.getByRole('option', { name: 'Ocean' }).click();
    await expect(this.page.locator('html')).toHaveClass(/theme-ocean/);
  }

  async colorProbe(agentId: string): Promise<{
    spark: ColorSample;
    wrapper: ColorSample;
    card: ColorSample;
    agentBody: string;
    sessionBody: string;
  }> {
    const spark = this.overlay.locator(
      '[data-marker-kind="ignition"][data-route-source="agent"] .agent-event-bus__marker-core',
    );
    await expect(spark).toBeAttached();
    return spark.evaluate((element, targetAgentId) => {
      interface Rgba extends ColorSample {
        a: number;
      }

      const parseColor = (value: string): Rgba => {
        const channels = value.match(/[\d.]+/g)?.map(Number) ?? [];
        if (channels.length < 3) throw new Error(`Unsupported computed color: ${value}`);
        return {
          r: channels[0],
          g: channels[1],
          b: channels[2],
          a: channels[3] ?? 1,
        };
      };
      const composite = (foreground: Rgba, background: Rgba): Rgba => {
        const alpha = foreground.a + background.a * (1 - foreground.a);
        if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
        return {
          r:
            (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) /
            alpha,
          g:
            (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) /
            alpha,
          b:
            (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) /
            alpha,
          a: alpha,
        };
      };
      const effectiveBackground = (target: Element): ColorSample => {
        const ancestors: Element[] = [];
        for (let current: Element | null = target; current; current = current.parentElement) {
          ancestors.push(current);
        }
        let result: Rgba = { r: 255, g: 255, b: 255, a: 1 };
        for (const ancestor of ancestors.reverse()) {
          result = composite(parseColor(getComputedStyle(ancestor).backgroundColor), result);
        }
        return { r: result.r, g: result.g, b: result.b };
      };

      const wrapper = document.querySelector('[data-testid="chat-main-agents-wrapper"]');
      const card = document.querySelector(`[data-agent-event-bus-agent-id="${targetAgentId}"]`);
      const agentBody = document.querySelector(
        '[data-event-kind="agent-message"] [data-pulse-role="body"]',
      );
      const sessionBody = document.querySelector(
        '[data-event-kind="session-started"] [data-pulse-role="body"]',
      );
      if (!wrapper || !card || !agentBody || !sessionBody) {
        throw new Error('Event-bus color probe targets are not mounted');
      }
      const sparkColor = parseColor(getComputedStyle(element).fill);
      return {
        spark: { r: sparkColor.r, g: sparkColor.g, b: sparkColor.b },
        wrapper: effectiveBackground(wrapper),
        card: effectiveBackground(card),
        agentBody: getComputedStyle(agentBody).stroke,
        sessionBody: getComputedStyle(sessionBody).stroke,
      };
    }, agentId);
  }
}

test.describe('Chat agent event bus', () => {
  test('preserves gutter geometry and keeps bus and row interactions separate', async ({
    page,
  }) => {
    await installRoutes(page);
    await page.goto('/chat');

    const wrapper = page.getByTestId('chat-main-agents-wrapper');
    const lane = page.getByTestId('agent-event-bus-control-lane');
    const overlay = page.getByTestId('agent-event-bus-svg');
    const row = page.getByRole('listitem', { name: /Chat with Epic Manager/i });
    await expect(wrapper).toBeVisible();
    await expect(row).toBeVisible();
    await expect(overlay.locator('.agent-event-bus__idle-anchor')).toHaveCount(3);

    const [wrapperBox, laneBox, rowBox, overlayBox] = await Promise.all([
      wrapper.boundingBox(),
      lane.boundingBox(),
      row.boundingBox(),
      overlay.boundingBox(),
    ]);
    expect(wrapperBox).not.toBeNull();
    expect(laneBox).not.toBeNull();
    expect(rowBox).not.toBeNull();
    expect(overlayBox).not.toBeNull();
    expect(laneBox!.x - wrapperBox!.x).toBe(0);
    expect(laneBox!.width).toBe(12);
    expect(rowBox!.x - wrapperBox!.x).toBeGreaterThanOrEqual(16);
    expect(laneBox!.x + laneBox!.width).toBeLessThanOrEqual(rowBox!.x);
    // The overlay reaches 16px left of the panel, into the page gutter, so the bloom is
    // not sliced at the panel edge. Rows and lane above must stay put regardless.
    expect(wrapperBox!.x - overlayBox!.x).toBe(16);
    expect(overlayBox!.width - wrapperBox!.width).toBe(16);
    await expect(overlay).toHaveCSS('pointer-events', 'none');
    await expect(overlay.locator('.agent-event-bus__idle-conductor')).toHaveAttribute(
      'd',
      /^M 4 8 V /,
    );

    await expect(wrapper).toHaveScreenshot('chat-agent-event-bus-idle.png', {
      animations: 'disabled',
      caret: 'hide',
    });

    const conductor = overlay.locator('.agent-event-bus__idle-conductor');
    const darkStroke = await conductor.evaluate((element) => getComputedStyle(element).stroke);
    await page.getByTestId('theme-toggle').click();
    await page.getByRole('option', { name: 'Ocean' }).click();
    await expect(page.locator('html')).toHaveClass(/theme-ocean/);
    const oceanStroke = await conductor.evaluate((element) => getComputedStyle(element).stroke);
    expect(oceanStroke).not.toBe('none');
    expect(oceanStroke).not.toBe(darkStroke);

    await lane.click({ button: 'right' });
    const reduceMotion = page.getByRole('menuitemcheckbox', { name: 'Reduce motion' });
    await expect(reduceMotion).toBeVisible();
    await reduceMotion.click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.localStorage.getItem('devchain:chatSidebar:eventBusReduceMotion'),
        ),
      )
      .toBe('true');

    await lane.focus();
    await page.keyboard.press('Shift+F10');
    await expect(reduceMotion).toBeVisible();
    await page.keyboard.press('Escape');

    await row.click({ button: 'right', position: { x: 5, y: 20 } });
    await expect(page.getByRole('menuitem', { name: 'Overrides…' })).toBeVisible();
    await expect(reduceMotion).not.toBeVisible();
    await page.keyboard.press('Escape');

    await row.click({ position: { x: 5, y: 20 } });
    await expect(page).toHaveURL(/\/chat\?thread=thread-agent-lead$/);
  });

  test('records one deterministic dark-theme pulse storyboard', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'The approved visual baseline is Chromium-only.');
    await page.clock.install({ time: new Date(NOW) });
    const storyboard = new EventBusStoryboard(page);
    await storyboard.open();
    // Wait for all three seeded agents to have registered a bus anchor. (This replaced a
    // count of 'Idle' badges, which no longer exist — see ChatSidebar.spec.tsx:536-537.)
    await expect(storyboard.overlay.locator('.agent-event-bus__idle-anchor')).toHaveCount(3);
    await page.clock.pauseAt(await page.evaluate(() => Date.now()));
    await storyboard.emitNestedTeamMessage();

    const ignition = storyboard.overlay.locator(
      '[data-marker-kind="ignition"][data-route-source="agent"]',
    );
    const sourceX = Number(
      await ignition.locator('.agent-event-bus__marker-core').getAttribute('cx'),
    );
    expect(sourceX).toBeGreaterThan(16);
    await expect(ignition).not.toHaveAttribute('filter');

    const clippedGlow = storyboard.page.getByTestId('agent-event-bus-clipped-glow-layer');
    // The bloom fades out across the gutter boundary instead of being hard-clipped, so a
    // round point light never shows a cut edge over a card.
    const fadeGradient = storyboard.overlay.locator('linearGradient');
    expect(Number(await fadeGradient.getAttribute('x1'))).toBe(16);
    expect(Number(await fadeGradient.getAttribute('x2'))).toBe(40);
    await expect(clippedGlow).toHaveAttribute('mask', /^url\(#agent-event-bus-glow-mask-/);
    const filteredAnimations = storyboard.overlay.locator('[data-route-animation][filter]');
    await expect(filteredAnimations).toHaveCount(1);
    expect(
      await filteredAnimations.evaluateAll(
        (elements, clippedLayerTestId) =>
          elements.every(
            (element) => element.closest(`[data-testid="${clippedLayerTestId}"]`) !== null,
          ),
        'agent-event-bus-clipped-glow-layer',
      ),
    ).toBe(true);
    await expect(clippedGlow.locator('[data-pulse-role="tail"]')).toHaveCount(1);

    await storyboard.seek('launch');
    await storyboard.screenshot('chat-agent-event-bus-launch.png');

    await storyboard.seek('mid-flight');
    await storyboard.screenshot('chat-agent-event-bus-mid-flight.png');

    const durationMs = await storyboard.routeDurationMs();
    await page.clock.fastForward(durationMs);
    await expect(storyboard.overlay.locator('[data-marker-kind="arrival"]')).toHaveCount(1);
    await storyboard.seek('arrival');
    await storyboard.screenshot('chat-agent-event-bus-arrival.png');
    await expect(storyboard.overlay.locator('[data-marker-kind="arrival"]')).toHaveCount(1);
    expect(
      await storyboard.overlay
        .locator('[data-marker-kind="arrival"]')
        .evaluate((element) => element.getAnimations().length),
    ).toBe(1);

    // Clock advances scheduler phases only; WAAPI positioning is controlled by seek().
    await page.clock.fastForward(240);
    await expect(storyboard.overlay.locator('[data-route-animation]')).toHaveCount(0);
  });

  test('proves spark and event-kind contrast on real dark and ocean surfaces', async ({ page }) => {
    const storyboard = new EventBusStoryboard(page);
    await storyboard.open();
    await storyboard.emitContrastRoutes();

    const dark = await storyboard.colorProbe('agent-coder');
    expect(contrastRatio(dark.spark, dark.wrapper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.spark, dark.card)).toBeGreaterThanOrEqual(4.5);
    expect(dark.agentBody).not.toBe(dark.sessionBody);

    await storyboard.selectOcean();
    const ocean = await storyboard.colorProbe('agent-coder');
    expect(contrastRatio(ocean.spark, ocean.wrapper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(ocean.spark, ocean.card)).toBeGreaterThanOrEqual(4.5);
    expect(ocean.agentBody).not.toBe(ocean.sessionBody);
    expect(ocean.agentBody).not.toBe(dark.agentBody);
    expect(ocean.sessionBody).not.toBe(dark.sessionBody);
    expect(ocean.spark).not.toEqual(dark.spark);
    expect(`rgb(${ocean.spark.r}, ${ocean.spark.g}, ${ocean.spark.b})`).not.toBe(ocean.agentBody);
    expect(`rgb(${ocean.spark.r}, ${ocean.spark.g}, ${ocean.spark.b})`).not.toBe(ocean.sessionBody);
  });
});
