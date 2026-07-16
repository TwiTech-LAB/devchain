/**
 * Real xterm 6 Chromium smoke for the trusted scroll-intent seam.
 *
 * Jest mocks the browser `Terminal`, so it can prove the seam's routing logic but NOT the xterm 6
 * SmoothScrollableElement's real DOM/event coupling. This smoke loads the SAME production modules
 * (`scroll-intent-binding` + `scroll-history-detector`) through the Vite dev server and drives them
 * with TRUSTED Chromium input (real wheel / pointer, not `dispatchEvent`), asserting:
 *   - a trusted wheel-up from the bottom moves xterm natively and yields exactly ONE decision;
 *   - a trusted scrollbar track click and a slider drag each yield exactly ONE decision;
 *   - terminal-content selection yields none;
 *   - a slow first slider move after gesture-intent expiry refreshes intent before xterm moves;
 *   - a wheel-capable TUI mouse mode forwards trusted input and yields NO host-history decision;
 *   - the drag controller exposes active/clean-end state.
 *
 * Prerequisite: the Vite dev server must be serving the Local App UI (`pnpm --filter local-app
 * dev:ui`, port 5175 by default). Override with XTERM6_SMOKE_BASE_URL. The smoke builds a
 * standalone terminal in the page and needs no API/socket backend.
 */
import { chromium } from '@playwright/test';

const BASE_URL = process.env.XTERM6_SMOKE_BASE_URL ?? 'http://127.0.0.1:5175';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(`${BASE_URL}/@vite/client`);

  // Build the terminal and wire the PRODUCTION seam + detector exactly as useXterm does.
  const setup = await page.evaluate(async () => {
    await import('/@id/@xterm/xterm/css/xterm.css');
    const xtermModule = await import('/@id/@xterm/xterm');
    const fitModule = await import('/@id/@xterm/addon-fit');
    const { createScrollIntentBinding } = await import(
      '/src/ui/components/terminal/scroll-intent-binding.ts'
    );
    const { createScrollHistoryDetector, SCROLL_GESTURE_STALE_MS } = await import(
      '/src/ui/components/terminal/scroll-history-detector.ts'
    );
    const Terminal = xtermModule.Terminal ?? xtermModule.default.Terminal;
    const FitAddon = fitModule.FitAddon ?? fitModule.default.FitAddon;

    const host = document.createElement('div');
    host.style.width = '800px';
    host.style.height = '420px';
    document.body.replaceChildren(host);

    const terminal = new Terminal({
      cols: 80,
      rows: 24,
      scrollback: 500,
      scrollSensitivity: 1,
      fastScrollSensitivity: 1,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    fitAddon.fit();

    const write = (data) => new Promise((resolve) => terminal.write(data, resolve));
    await write(Array.from({ length: 300 }, (_, index) => `line-${index}\r\n`).join(''));
    terminal.scrollToBottom();

    let ttyMode = false;
    let mouseInput = '';
    terminal.onData((data) => {
      mouseInput += data;
    });

    // Short cooldown isolates the seam's DOM routing (the cooldown/cycle policy is unit-proven);
    // the gesture-stale window stays at the production default so the intent-expiry phase is real.
    const detector = createScrollHistoryDetector({ cooldownMs: 0 });
    const controller = createScrollIntentBinding({
      container: host,
      stampIntent: (now) => detector.stampScrollIntent(now),
      getMouseTrackingMode: () => terminal.modes.mouseTrackingMode,
      isTtyMode: () => ttyMode,
    });

    let decisions = 0;
    const dragEnds = [];
    controller.onDragEnd((reason) => dragEnds.push(reason));

    // Mirror useXterm's 100ms poll: read the live buffer and run the SAME detector decision.
    const poll = setInterval(() => {
      const buffer = terminal.buffer.active;
      const decision = detector.shouldRequestHistory({
        viewportY: buffer.viewportY,
        baseY: buffer.baseY,
        visible: true,
        hasHistory: !ttyMode, // alt-screen TUI is not host-refreshable
        inFlight: false,
        now: Date.now(),
      });
      if (decision.shouldRequest) decisions += 1;
    }, 16);

    const rect = (selector) => {
      const el = host.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };

    window.__xterm6Smoke = {
      SCROLL_GESTURE_STALE_MS,
      getDecisions: () => decisions,
      resetDecisions: () => {
        decisions = 0;
      },
      isDragActive: () => controller.isDragActive(),
      getDragEnds: () => dragEnds.slice(),
      viewportY: () => terminal.buffer.active.viewportY,
      baseY: () => terminal.buffer.active.baseY,
      // Return to the bottom and let the poll observe it (clears the in-cycle latch) before the
      // next phase; resetting decisions here keeps each phase's count independent.
      rearmAtBottom: () => {
        terminal.scrollToBottom();
      },
      setTty: (value) => {
        ttyMode = value;
      },
      mouseTrackingMode: () => terminal.modes.mouseTrackingMode,
      mouseInput: () => mouseInput,
      resetMouseInput: () => {
        mouseInput = '';
      },
      enableTuiMouse: () => write('\x1b[?1049h\x1b[?1000h\x1b[?1006h'),
      disableTuiMouse: () => write('\x1b[?1006l\x1b[?1000l\x1b[?1049l'),
      rects: () => ({
        screen: rect('.xterm-screen'),
        scrollbar: rect('.xterm-scrollable-element > .scrollbar.vertical'),
        slider: rect('.xterm-scrollable-element > .scrollbar.vertical > .slider'),
      }),
      teardown: () => {
        clearInterval(poll);
        controller.dispose();
      },
    };

    return {
      customScrollbarPresent: Boolean(
        host.querySelector('.xterm-scrollable-element > .scrollbar.vertical'),
      ),
      atBottom: terminal.buffer.active.viewportY === terminal.buffer.active.baseY,
      baseY: terminal.buffer.active.baseY,
      gestureStaleMs: SCROLL_GESTURE_STALE_MS,
    };
  });

  if (!setup.customScrollbarPresent) throw new Error('xterm 6 custom scrollbar was not mounted');
  if (!setup.atBottom || setup.baseY <= 0) throw new Error('Terminal did not seed scrollback');

  const smoke = (fn, ...args) => page.evaluate(fn, ...args);
  const settle = () => page.waitForTimeout(120);
  const rects = () => smoke(() => window.__xterm6Smoke.rects());
  // Keep the pointer over the terminal so xterm reveals the auto-hiding scrollbar (pointer-events
  // are off while `.invisible`), then read the live geometry.
  const hoverTerminal = async () => {
    const r = await rects();
    await page.mouse.move(r.screen.x + r.screen.width / 2, r.screen.y + r.screen.height / 2);
  };
  const rearm = async () => {
    await smoke(() => window.__xterm6Smoke.rearmAtBottom());
    await settle();
    await smoke(() => window.__xterm6Smoke.resetDecisions());
  };

  // --- Phase 1: trusted wheel-up from the bottom moves xterm natively → exactly one decision ---
  await rearm();
  const beforeWheelY = await smoke(() => window.__xterm6Smoke.viewportY());
  await hoverTerminal();
  await page.mouse.wheel(0, -240); // negative deltaY = scroll up into history
  await settle();
  const wheel = {
    decisions: await smoke(() => window.__xterm6Smoke.getDecisions()),
    movedNatively: (await smoke(() => window.__xterm6Smoke.viewportY())) < beforeWheelY,
  };
  if (!wheel.movedNatively) throw new Error('Trusted wheel-up did not move xterm natively');
  if (wheel.decisions !== 1) {
    throw new Error(`Trusted wheel-up expected exactly one decision, got ${wheel.decisions}`);
  }

  // --- Phase 2: trusted scrollbar track click → exactly one decision ---
  await rearm();
  await hoverTerminal();
  let r = await rects();
  if (!r.scrollbar || !r.slider) throw new Error('Vertical scrollbar/slider did not render');
  // Click the track above the slider (a track region the slider does not currently cover).
  const trackX = r.scrollbar.x + r.scrollbar.width / 2;
  const trackY = r.scrollbar.y + 8;
  await page.mouse.click(trackX, trackY);
  await settle();
  const track = { decisions: await smoke(() => window.__xterm6Smoke.getDecisions()) };
  if (track.decisions !== 1) {
    throw new Error(`Trusted track click expected exactly one decision, got ${track.decisions}`);
  }

  // --- Phase 3: trusted slider drag → exactly one decision + clean drag lifecycle ---
  await rearm();
  await hoverTerminal();
  r = await rects();
  const sliderX = r.slider.x + r.slider.width / 2;
  const sliderY = r.slider.y + r.slider.height / 2;
  await page.mouse.move(sliderX, sliderY);
  await page.mouse.down();
  const dragActiveDuring = await smoke(() => window.__xterm6Smoke.isDragActive());
  await page.mouse.move(sliderX, sliderY - 80, { steps: 8 }); // drag the slider up
  await page.mouse.up();
  await settle();
  const drag = {
    decisions: await smoke(() => window.__xterm6Smoke.getDecisions()),
    activeDuring: dragActiveDuring,
    activeAfter: await smoke(() => window.__xterm6Smoke.isDragActive()),
    ends: await smoke(() => window.__xterm6Smoke.getDragEnds()),
  };
  if (!drag.activeDuring) throw new Error('Drag controller did not report an active slider drag');
  if (drag.activeAfter) throw new Error('Drag controller did not clear after pointerup');
  if (!drag.ends.includes('pointerup')) throw new Error('Drag end (pointerup) was not exposed');
  if (drag.decisions !== 1) {
    throw new Error(`Trusted slider drag expected exactly one decision, got ${drag.decisions}`);
  }

  // --- Phase 4: terminal-content selection produces no decision ---
  await rearm();
  r = await rects();
  const selY = r.screen.y + r.screen.height / 2;
  await page.mouse.move(r.screen.x + 20, selY);
  await page.mouse.down();
  await page.mouse.move(r.screen.x + 200, selY, { steps: 6 });
  await page.mouse.up();
  await settle();
  const selection = { decisions: await smoke(() => window.__xterm6Smoke.getDecisions()) };
  if (selection.decisions !== 0) {
    throw new Error(`Content selection must produce no decision, got ${selection.decisions}`);
  }

  // --- Phase 5: slow first slider move after intent expiry refreshes intent before xterm moves ---
  await rearm();
  await hoverTerminal();
  r = await rects();
  const slowX = r.slider.x + r.slider.width / 2;
  const slowY = r.slider.y + r.slider.height / 2;
  await page.mouse.move(slowX, slowY);
  await page.mouse.down();
  // Hold past the gesture-stale window so the pointerdown's intent expires; the FIRST move must
  // re-stamp intent (in the capture phase) before xterm moves the viewport, or no decision fires.
  await page.waitForTimeout(setup.gestureStaleMs + 400);
  await page.mouse.move(slowX, slowY - 80, { steps: 8 });
  await page.mouse.up();
  await settle();
  const slowDrag = { decisions: await smoke(() => window.__xterm6Smoke.getDecisions()) };
  if (slowDrag.decisions !== 1) {
    throw new Error(
      `Slow slider move after intent expiry expected one refreshed decision, got ${slowDrag.decisions}`,
    );
  }

  // --- Phase 6: wheel-capable TUI mouse mode forwards trusted input, no host-history decision ---
  await rearm();
  await smoke(() => window.__xterm6Smoke.setTty(true));
  await smoke(() => window.__xterm6Smoke.enableTuiMouse());
  const mouseTrackingMode = await smoke(() => window.__xterm6Smoke.mouseTrackingMode());
  await smoke(() => window.__xterm6Smoke.resetMouseInput());
  await smoke(() => window.__xterm6Smoke.resetDecisions());
  await hoverTerminal();
  await page.mouse.wheel(0, -240);
  await settle();
  const tui = {
    mode: mouseTrackingMode,
    forwarded: (await smoke(() => window.__xterm6Smoke.mouseInput())).includes('\x1b[<'),
    decisions: await smoke(() => window.__xterm6Smoke.getDecisions()),
  };
  await smoke(() => window.__xterm6Smoke.disableTuiMouse());
  await smoke(() => window.__xterm6Smoke.setTty(false));
  if (mouseTrackingMode === 'none') throw new Error('Alternate-screen mouse mode did not activate');
  if (!tui.forwarded) throw new Error('TUI wheel was not forwarded as trusted mouse input');
  if (tui.decisions !== 0) {
    throw new Error(`TUI wheel must produce no host-history decision, got ${tui.decisions}`);
  }

  await smoke(() => window.__xterm6Smoke.teardown());

  const result = {
    customScrollbarPresent: setup.customScrollbarPresent,
    wheel,
    track,
    drag,
    selection,
    slowDrag,
    tui,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await browser.close();
}
