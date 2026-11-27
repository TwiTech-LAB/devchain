import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

// Layer: Playwright browser E2E. Wheel routing, clipping, row measurement and focus
// order need real layout, which jsdom does not implement.
const SESSION_ID = 'e2e-single-scroll';
const CHUNK_COUNT = 40;
const NOW = '2026-02-24T10:00:00.000Z';
const HARNESS_URL = `/test/e2e/fixtures/session-reader-harness.html?session=${SESSION_ID}`;
const LAST_INDEX = CHUNK_COUNT - 1;

const METRICS = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 0,
  messageCount: 1,
  durationMs: 1000,
  costUsd: 0,
};

function longText(label: string): string {
  const lines = Array.from({ length: 80 }, (_, i) => `${label} line ${i + 1}`);
  return `${lines.join('\n')}\n${label} END`;
}

/** A chunk as the mocked server sends it; variants add their own step shapes. */
type FixtureChunk = { id: string } & Record<string, unknown>;

/** Even rows are user turns, odd rows AI turns whose latest output is long. */
function makeChunk(index: number) {
  const id = `chunk-${index}`;
  if (index % 2 === 0) {
    return {
      id,
      type: 'user',
      startTime: NOW,
      endTime: NOW,
      metrics: METRICS,
      messages: [
        {
          id: `msg-${index}`,
          parentId: null,
          role: 'user',
          timestamp: NOW,
          content: [{ type: 'text', text: longText(`user ${index}`) }],
          toolCalls: [],
          toolResults: [],
          isMeta: false,
          isSidechain: false,
        },
      ],
    };
  }
  return {
    id,
    type: 'ai',
    startTime: NOW,
    endTime: NOW,
    metrics: METRICS,
    messages: [
      {
        id: `msg-${index}`,
        parentId: null,
        role: 'assistant',
        timestamp: NOW,
        model: 'e2e-model',
        content: [{ type: 'text', text: 'answer' }],
        toolCalls: [],
        toolResults: [],
        isMeta: false,
        isSidechain: false,
      },
    ],
    // Step ids restart in every chunk, as the server builds them.
    semanticSteps: [
      {
        id: 'step-0',
        type: 'output',
        startTime: NOW,
        durationMs: 0,
        content: { outputText: longText(`output ${index}`).replace(/\n/g, '\n\n') },
        context: 'main',
      },
    ],
  };
}

/** A short Thinking step the live last row shows before its output. */
const SHORT_THINKING = {
  id: 'step-think-short',
  type: 'thinking',
  startTime: NOW,
  durationMs: 0,
  content: { thinkingText: 'short live thought' },
  context: 'main',
};

/** The last AI turn of a live session: a short Thinking step before its output. */
function makeLiveLastChunk() {
  const chunk = makeChunk(LAST_INDEX);
  return { ...chunk, semanticSteps: [SHORT_THINKING, ...chunk.semanticSteps!] };
}

/** The last AI turn after a live update: twelve more thinking steps before its output. */
function makeGrownLastChunk() {
  const chunk = makeChunk(LAST_INDEX);
  const thinking = Array.from({ length: 12 }, (_, i) => ({
    id: `step-think-${i}`,
    type: 'thinking',
    startTime: NOW,
    durationMs: 0,
    content: { thinkingText: `live thinking ${i}` },
    context: 'main',
  }));
  return { ...chunk, semanticSteps: [SHORT_THINKING, ...thinking, ...chunk.semanticSteps!] };
}

const TOOL_CALL_ID = 'tc-last';
const TOOL_PREVIEW = longText('tool preview');
const TOOL_FULL = `${TOOL_PREVIEW}\n${longText('tool rest')}\nTOOL TAIL`;

/** The last AI turn of a finished session whose latest output is a server-truncated tool result. */
function makeToolResultLastChunk() {
  const chunk = makeChunk(LAST_INDEX);
  return {
    ...chunk,
    semanticSteps: [
      {
        id: 'step-0',
        type: 'tool_result',
        startTime: NOW,
        durationMs: 0,
        content: {
          toolCallId: TOOL_CALL_ID,
          toolResultContent: TOOL_PREVIEW,
          isTruncated: true,
          fullLength: TOOL_FULL.length,
        },
        context: 'main',
      },
    ],
  };
}

/**
 * The live last AI turn whose latest output is a short, server-truncated tool result.
 * With `withLiveStep`, a live update has added one Thinking step to the same turn.
 */
function makeLiveToolResultLastChunk(withLiveStep: boolean) {
  const chunk = makeToolResultLastChunk();
  const [result] = chunk.semanticSteps;
  const shortResult = {
    ...result,
    id: 'step-result',
    content: { ...result.content, toolResultContent: 'short tool preview' },
  };
  const liveStep = {
    id: 'step-live-thought',
    type: 'thinking',
    startTime: NOW,
    durationMs: 0,
    content: { thinkingText: 'one more live thought' },
    context: 'main',
  };
  return { ...chunk, semanticSteps: withLiveStep ? [liveStep, shortResult] : [shortResult] };
}

const CHUNKS = Array.from({ length: CHUNK_COUNT }, (_, i) => makeChunk(i));
const CHUNK_IDS = CHUNKS.map((chunk) => chunk.id);

/** What the mocked server returns; a test flips it to simulate a live session. */
interface MockServerState {
  live: boolean;
  /** When set, the full tool result response waits for this promise. */
  toolResultGate?: Promise<void>;
  /** Replaces the last chunk the server returns. */
  lastChunkOverride?: FixtureChunk;
}

function chunksFor(state: MockServerState) {
  const head = CHUNKS.slice(0, LAST_INDEX);
  if (state.lastChunkOverride) return [...head, state.lastChunkOverride];
  if (state.live) return [...head, makeLiveLastChunk()];
  return CHUNKS;
}

function page(state: MockServerState, start: number, size: number) {
  const chunks = chunksFor(state).slice(start, start + size);
  return {
    chunks,
    nextCursor: CHUNK_IDS[start + size] ?? null,
    prevCursor: start > 0 ? CHUNK_IDS[start - 1] : null,
    totalCount: CHUNK_COUNT,
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installRoutes(target: Page, state: MockServerState) {
  // Everything stays in the browser: no request reaches a running API server.
  await target.route('**/socket.io/**', (route) => route.abort());
  await target.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith(`/sessions/${SESSION_ID}/transcript/index`)) {
      const pageSize = Number(url.searchParams.get('pageSize') ?? 10);
      const first = Number(url.searchParams.get('firstVirtualIndex') ?? 0);
      const last = Number(url.searchParams.get('lastVirtualIndex') ?? first);
      const pages = [];
      for (let start = Math.floor(first / pageSize) * pageSize; start <= last; start += pageSize) {
        pages.push({
          cursor: CHUNK_IDS[start],
          size: pageSize,
          response: page(state, start, pageSize),
        });
      }
      return json(route, {
        cursor: 'index-cursor',
        totals: { messageCount: CHUNK_COUNT, chunkCount: CHUNK_COUNT },
        chunkIds: CHUNK_IDS,
        latestOutputPreview: null,
        providerName: 'claude-code',
        isOngoing: state.live,
        pages,
      });
    }
    if (path.endsWith(`/sessions/${SESSION_ID}/transcript/chunks`)) {
      const cursor = url.searchParams.get('cursor');
      const limit = Number(url.searchParams.get('limit') ?? 10);
      return json(route, page(state, Math.max(0, CHUNK_IDS.indexOf(cursor ?? '')), limit));
    }
    if (path.endsWith(`/sessions/${SESSION_ID}/transcript/tool-result/${TOOL_CALL_ID}`)) {
      const respond = () =>
        json(route, {
          sessionId: SESSION_ID,
          toolCallId: TOOL_CALL_ID,
          content: TOOL_FULL,
          isError: false,
          fullLength: TOOL_FULL.length,
        });
      return state.toolResultGate ? state.toolResultGate.then(respond) : respond();
    }
    return json(route, { message: 'not mocked' }, 404);
  });
}

class TranscriptPage {
  readonly scroller: Locator;

  readonly state: MockServerState = { live: false };

  constructor(readonly page: Page) {
    this.scroller = page.getByTestId('paged-session-viewer-scroll');
  }

  async open() {
    await installRoutes(this.page, this.state);
    await this.page.goto(HARNESS_URL);
    await expect(this.row(0).getByTestId('user-message-card')).toBeVisible();
  }

  async openLive() {
    this.state.live = true;
    await installRoutes(this.page, this.state);
    await this.page.goto(`${HARNESS_URL}&live=1`);
    await this.scrollToEndUntil(this.row(LAST_INDEX).getByTestId('last-output-display'));
  }

  /** Scrolls to the end until `target` is rendered there (rows load as they come into view). */
  async scrollToEndUntil(target: Locator) {
    await expect
      .poll(async () => {
        await this.scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));
        return target.count();
      })
      .toBe(1);
  }

  /** Scrolls to the end until the list stops growing there. */
  async scrollToEnd() {
    await expect
      .poll(async () => {
        await this.scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));
        return this.distanceToBottom();
      })
      .toBeLessThanOrEqual(1);
  }

  /** Scrolls to the end once the given control in the last row exists, and checks it is in view. */
  async scrollToEndOnce(control: Locator) {
    await this.scrollToEndUntil(control);
    await this.scrollToEnd();
    await expect(control).toBeInViewport();
  }

  /** Pixels between the bottom of the viewport and the end of the list. */
  distanceToBottom(): Promise<number> {
    return this.scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  }

  scrollHeight(): Promise<number> {
    return this.scroller.evaluate((el) => el.scrollHeight);
  }

  /** Delivers the transcript delta the server pushes when the live AI turn grows. */
  async pushLastChunkGrowth() {
    await this.pushLastChunk(makeGrownLastChunk());
  }

  /** Delivers the transcript delta that replaces the live last chunk with `grown`. */
  async pushLastChunk(grown: FixtureChunk) {
    this.state.lastChunkOverride = grown;
    await this.page.evaluate(
      async ({ sessionId, chunk, total }) => {
        const socketModule: typeof import('../../src/ui/lib/socket') =
          // @ts-expect-error Vite serves this browser module; the Playwright Node process does not.
          await import('/src/ui/lib/socket.ts');
        const socket = socketModule.getAppSocket('home');
        const envelope = {
          topic: `session/${sessionId}/transcript`,
          type: 'updated',
          payload: {
            kind: 'delta',
            sessionId,
            cursor: 'index-cursor-2',
            prevCursor: 'index-cursor',
            replaceFromChunkIndex: total - 1,
            newChunkIds: [chunk.id],
            totalChunkCount: total,
            deltaChunks: [chunk],
            deltaMessages: chunk.messages,
            metrics: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
              messageCount: total,
            },
          },
          ts: new Date().toISOString(),
        };
        for (const listener of socket.listeners('message')) listener(envelope);
        socketModule.releaseAppSocket('home');
      },
      { sessionId: SESSION_ID, chunk: grown, total: CHUNK_COUNT },
    );
  }

  row(index: number): Locator {
    return this.page.locator(`[data-index="${index}"]`);
  }

  toggle(row: Locator, name: 'Show full' | 'Show less'): Locator {
    return row.getByRole('button', { name, exact: true });
  }

  /** The one control of a result the server cut: it expands the block and loads the full body. */
  loadFullResultToggle(row: Locator): Locator {
    return row.getByRole('button', { name: /^Show full/ });
  }

  scrollTop(): Promise<number> {
    return this.scroller.evaluate((el) => el.scrollTop);
  }

  async scrollBy(delta: number) {
    await this.scroller.evaluate((el, dy) => el.scrollBy(0, dy), delta);
  }

  /** Top of an element relative to the scroller viewport. */
  topOf(locator: Locator): Promise<number> {
    return locator.evaluate((el) => {
      const scroller = el.closest('[data-transcript-scroll-container]')!;
      return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    });
  }

  /** Top of the preview block a toggle controls, relative to the scroller viewport. */
  blockTopOf(toggle: Locator): Promise<number> {
    return toggle.evaluate((button) => {
      const block = document.getElementById(button.getAttribute('aria-controls')!)!.parentElement!;
      const scroller = block.closest('[data-transcript-scroll-container]')!;
      return block.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    });
  }

  /** Top of an element in scroll-content coordinates, independent of the scroll position. */
  contentTopOf(locator: Locator): Promise<number> {
    return locator.evaluate((el) => {
      const scroller = el.closest('[data-transcript-scroll-container]')!;
      return (
        el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      );
    });
  }

  /** Space between the bottom of one row and the top of the next. */
  gapAfter(index: number): Promise<number> {
    return this.page.evaluate((i) => {
      const current = document.querySelector(`[data-index="${i}"]`)!.getBoundingClientRect();
      const next = document.querySelector(`[data-index="${i + 1}"]`)!.getBoundingClientRect();
      return next.top - current.bottom;
    }, index);
  }
}

test.describe('Session reader — single vertical scroller', () => {
  let transcript: TranscriptPage;

  test.beforeEach(async ({ page: browserPage }) => {
    transcript = new TranscriptPage(browserPage);
    await transcript.open();
  });

  test('the wheel over a preview scrolls the main list', async ({ page: browserPage }) => {
    const preview = transcript.row(0).getByTestId('user-message-card');
    await expect(transcript.toggle(transcript.row(0), 'Show full')).toBeVisible();
    const box = (await preview.boundingBox())!;

    await browserPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await browserPage.mouse.wheel(0, 300);

    await expect.poll(() => transcript.scrollTop()).toBeGreaterThan(0);
    const clip = preview.locator('[aria-controls]').evaluate((button) => {
      const target = document.getElementById(button.getAttribute('aria-controls')!)!;
      return { scrollTop: target.scrollTop, overflowY: getComputedStyle(target).overflowY };
    });
    expect(await clip).toEqual({ scrollTop: 0, overflowY: 'clip' });
  });

  test('expanding at the bottom of a tall block does not move the view', async () => {
    const row = transcript.row(0);
    const card = row.getByTestId('user-message-card');
    // The block starts above the viewport top; its toggle is in view.
    await transcript.scrollBy(200);
    await expect(transcript.toggle(row, 'Show full')).toBeInViewport();
    const scrollBefore = await transcript.scrollTop();
    const topBefore = await transcript.topOf(card);

    await transcript.toggle(row, 'Show full').click();

    await expect(card).toContainText('user 0 END');
    await expect(transcript.toggle(row, 'Show less')).toBeVisible();
    await expect.poll(() => transcript.topOf(card)).toBeCloseTo(topBefore, 0);
    expect(await transcript.scrollTop()).toBe(scrollBefore);
  });

  test('expanding the last output at the end of a finished transcript keeps the reading position', async () => {
    const lastRow = transcript.row(LAST_INDEX);
    const toggle = transcript.toggle(lastRow, 'Show full');
    await transcript.scrollToEndOnce(toggle);
    const scrollBefore = await transcript.scrollTop();
    const heightBefore = await transcript.scrollHeight();

    await toggle.click();

    await expect(lastRow.getByTestId('last-output-display')).toContainText(
      `output ${LAST_INDEX} END`,
    );
    await expect.poll(() => transcript.scrollHeight()).toBeGreaterThan(heightBefore + 100);
    // The newly shown text starts where the preview ended, so the view must not follow the end.
    expect(await transcript.scrollTop()).toBe(scrollBefore);
    expect(await transcript.distanceToBottom()).toBeGreaterThan(100);
  });

  test('collapsing leaves no gap', async () => {
    const row = transcript.row(0);
    const next = transcript.row(1);
    await expect(next).toBeAttached();
    const gapBefore = await transcript.gapAfter(0);
    const nextTopBefore = await transcript.contentTopOf(next);

    await transcript.toggle(row, 'Show full').click();
    await expect.poll(() => transcript.contentTopOf(next)).toBeGreaterThan(nextTopBefore);
    // The click scrolls the toggle at the end of the tall block into view first.
    await transcript.toggle(row, 'Show less').click();

    await expect.poll(() => transcript.gapAfter(0)).toBeCloseTo(gapBefore, 0);
    await expect.poll(() => transcript.contentTopOf(next)).toBeCloseTo(nextTopBefore, 0);
    // The collapsed block's top is back in view.
    expect(await transcript.blockTopOf(transcript.toggle(row, 'Show full'))).toBeGreaterThanOrEqual(
      0,
    );
  });

  test('an expanded block is still expanded after its row leaves the retention window', async () => {
    await transcript.toggle(transcript.row(1), 'Show full').click();
    await expect(transcript.toggle(transcript.row(1), 'Show less')).toBeVisible();

    await transcript.scrollToEndUntil(transcript.row(CHUNK_COUNT - 1));
    await expect(transcript.row(1)).toHaveCount(0);

    await expect
      .poll(async () => {
        await transcript.scroller.evaluate((el) => el.scrollTo(0, 0));
        return transcript.toggle(transcript.row(1), 'Show less').count();
      })
      .toBe(1);
    await expect(transcript.row(1).getByTestId('last-output-display')).toContainText(
      'output 1 END',
    );
  });

  test('Tab reaches the toggle and Enter expands the block', async ({ page: browserPage }) => {
    const row = transcript.row(0);
    // A click on plain text moves the sequential focus start point there.
    await row.getByTestId('user-message-card').getByText('User', { exact: true }).click();
    await browserPage.keyboard.press('Tab');

    const toggle = transcript.toggle(row, 'Show full');
    await expect(toggle).toBeFocused();
    await browserPage.keyboard.press('Enter');

    await expect(transcript.toggle(row, 'Show less')).toBeFocused();
    await expect(transcript.toggle(row, 'Show less')).toHaveAttribute('aria-expanded', 'true');
  });
});

test.describe('Session reader — delayed full result', () => {
  test('a full result that arrives after a key press keeps the reading position', async ({
    page: browserPage,
  }) => {
    const transcript = new TranscriptPage(browserPage);
    let releaseResult = () => {};
    transcript.state.lastChunkOverride = makeToolResultLastChunk();
    transcript.state.toolResultGate = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    await transcript.open();
    const lastRow = transcript.row(LAST_INDEX);
    const toggle = transcript.loadFullResultToggle(lastRow);
    await transcript.scrollToEndOnce(toggle);

    await toggle.click();
    await expect(lastRow.getByTestId('tool-result-loading')).toBeVisible();
    const showLess = transcript.toggle(lastRow, 'Show less');
    await expect(showLess).toBeFocused();
    const scrollBefore = await transcript.scrollTop();
    const heightBefore = await transcript.scrollHeight();
    // A copy shortcut is not a scroll: it must not change what the later body does.
    await browserPage.keyboard.press('Control+c');
    releaseResult();

    await expect(lastRow.getByTestId('last-output-display')).toContainText('TOOL TAIL');
    await expect.poll(() => transcript.scrollHeight()).toBeGreaterThan(heightBefore + 100);
    expect(await transcript.scrollTop()).toBe(scrollBefore);
  });
});

test.describe('Session reader — live session', () => {
  test('a full result that arrives after a live step in the same row keeps the reading position', async ({
    page: browserPage,
  }) => {
    const transcript = new TranscriptPage(browserPage);
    let releaseResult = () => {};
    transcript.state.lastChunkOverride = makeLiveToolResultLastChunk(false);
    transcript.state.toolResultGate = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    await transcript.openLive();
    const lastRow = transcript.row(LAST_INDEX);
    const toggle = transcript.loadFullResultToggle(lastRow);
    await transcript.scrollToEndOnce(toggle);

    await toggle.click();
    await expect(lastRow.getByTestId('tool-result-loading')).toBeVisible();
    await transcript.pushLastChunk(makeLiveToolResultLastChunk(true));
    await expect(lastRow.getByText('one more live thought')).toBeAttached();
    await expect(transcript.toggle(lastRow, 'Show less')).toBeFocused();
    const scrollBefore = await transcript.scrollTop();
    const heightBefore = await transcript.scrollHeight();
    releaseResult();

    await expect(lastRow.getByTestId('last-output-display')).toContainText('TOOL TAIL');
    await expect.poll(() => transcript.scrollHeight()).toBeGreaterThan(heightBefore + 100);
    expect(await transcript.scrollTop()).toBe(scrollBefore);
  });

  test('a reader at the bottom follows a live update after opening and closing a block', async ({
    page: browserPage,
  }) => {
    const transcript = new TranscriptPage(browserPage);
    await transcript.openLive();
    const lastRow = transcript.row(LAST_INDEX);
    const thinking = lastRow.getByTestId('thinking-block-trigger');
    await expect(thinking).toBeAttached();
    await transcript.scrollToEnd();

    await thinking.click();
    await expect(lastRow.getByText('short live thought', { exact: true })).toBeVisible();
    await thinking.click();
    await expect(lastRow.getByText('short live thought', { exact: true })).toBeHidden();
    await transcript.scrollToEnd();
    const heightBefore = await transcript.scrollHeight();

    await transcript.pushLastChunkGrowth();

    await expect(lastRow.getByText('live thinking 11')).toBeAttached();
    await expect.poll(() => transcript.scrollHeight()).toBeGreaterThan(heightBefore + 100);
    await expect.poll(() => transcript.distanceToBottom()).toBeLessThanOrEqual(1);
  });

  test('a reader at the bottom stays at the bottom when the latest row grows', async ({
    page: browserPage,
  }) => {
    const transcript = new TranscriptPage(browserPage);
    await transcript.openLive();
    await transcript.scrollToEnd();
    const heightBefore = await transcript.scrollHeight();

    await transcript.pushLastChunkGrowth();

    const lastRow = transcript.row(LAST_INDEX);
    // The latest AI turn of a live session opens expanded, so its new steps add height.
    await expect(lastRow.getByTestId('ai-group-expanded')).toBeVisible();
    await expect(lastRow.getByText('live thinking 11')).toBeAttached();
    await expect.poll(() => transcript.scrollHeight()).toBeGreaterThan(heightBefore + 100);
    await expect.poll(() => transcript.distanceToBottom()).toBeLessThanOrEqual(1);
    await expect(lastRow.getByTestId('last-output-display')).toBeInViewport();
  });
});
