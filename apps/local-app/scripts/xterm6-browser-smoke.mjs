/**
 * Real xterm 6 Chromium smoke for trusted terminal input-intent seams.
 *
 * Jest mocks the browser `Terminal`, so it can prove the seam's routing logic but NOT the xterm 6
 * SmoothScrollableElement's real DOM/event coupling. This smoke loads the SAME production modules
 * through the Vite dev server and drives them with trusted Chromium input. Synthetic file lists
 * check the mixed payloads that the browser clipboard API cannot create. The smoke asserts:
 *   - physical keys and clipboard/text insertion produce input intent before xterm onData;
 *   - bare Ctrl+V pastes text or captures images and forwards SYN for an empty clipboard;
 *   - xterm and form file pastes preserve order and consume text fallback;
 *   - programmatic blur/focus DEC reports reach onData without producing input intent;
 *   - selected Ctrl+C copies exact text through one xterm-served event and clears in a macrotask;
 *   - held-key repeat is suppressed, leaves a distinct clipboard sentinel unchanged, and keyup
 *     restores the next no-selection Ctrl+C ETX;
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
 * OS-level IME composition and virtual-keyboard entry remain manual checks because Playwright
 * cannot select or drive those platform input methods deterministically.
 */
import { chromium } from '@playwright/test';

const BASE_URL = process.env.XTERM6_SMOKE_BASE_URL ?? 'http://127.0.0.1:5175';

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1000, height: 700 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/@vite/client`);

  // Build the terminal and wire the PRODUCTION seam + detector exactly as useXterm does.
  const setup = await page.evaluate(async () => {
    await import('/@id/@xterm/xterm/css/xterm.css');
    const xtermModule = await import('/@id/@xterm/xterm');
    const fitModule = await import('/@id/@xterm/addon-fit');
    const { createScrollIntentBinding } = await import(
      '/src/ui/components/terminal/scroll-intent-binding.ts'
    );
    const { createTerminalInputIntentBinding } = await import(
      '/src/ui/components/terminal/terminal-input-intent-binding.ts'
    );
    const { createCtrlCSelectionBinding } = await import(
      '/src/ui/components/terminal/ctrl-c-selection-binding.ts'
    );
    const { createTerminalClipboardPasteBinding, readClipboardImages } = await import(
      '/src/ui/components/terminal/terminal-clipboard-paste.ts'
    );
    const { createScrollHistoryDetector, SCROLL_GESTURE_STALE_MS } = await import(
      '/src/ui/components/terminal/scroll-history-detector.ts'
    );
    const Terminal = xtermModule.Terminal ?? xtermModule.default.Terminal;
    const FitAddon = fitModule.FitAddon ?? fitModule.default.FitAddon;

    const host = document.createElement('div');
    host.style.width = '800px';
    host.style.height = '420px';
    const textarea = document.createElement('textarea');
    textarea.id = 'form-input';
    document.body.replaceChildren(host, textarea);

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
    const inputTrace = [];
    const domInputTrace = [];
    const keyTrace = [];
    const keydownTrace = [];
    const copyTrace = [];
    const clipboardFailures = [];
    const filePastes = [];
    terminal.onData((data) => {
      mouseInput += data;
      inputTrace.push({ marker: 'input', data });
    });
    terminal.onKey(({ key, domEvent }) => {
      keyTrace.push({ key, trusted: domEvent.isTrusted });
    });
    host.addEventListener(
      'keydown',
      (event) => {
        keydownTrace.push({
          keyCode: event.keyCode,
          repeat: event.repeat,
          trusted: event.isTrusted,
        });
      },
      { capture: true },
    );
    host.addEventListener('copy', (event) => {
      copyTrace.push({
        served: event.defaultPrevented,
        trusted: event.isTrusted,
        selectionPresent: terminal.hasSelection(),
      });
    });
    for (const type of ['paste', 'compositionstart', 'beforeinput']) {
      host.addEventListener(
        type,
        (event) => {
          domInputTrace.push({
            type,
            trusted: event.isTrusted,
            inputType: event instanceof InputEvent ? event.inputType : null,
            data: event instanceof InputEvent ? event.data : null,
            clipboardText:
              event instanceof ClipboardEvent ? event.clipboardData?.getData('text/plain') : null,
          });
        },
        { capture: true },
      );
    }
    const claimFocus = () => inputTrace.push({ marker: 'focus' });
    const recordFiles = (target, paste) => {
      filePastes.push(
        readClipboardImages(paste).then(async ({ images, ...failures }) => ({
          target,
          count: paste.browserFileCount,
          ...failures,
          images: await Promise.all(
            images.map(async ({ file, mimeType }) => ({
              name: file.name,
              mimeType,
              bytes: [...new Uint8Array(await file.arrayBuffer())],
            })),
          ),
        })),
      );
    };
    const ttyPaste = createTerminalClipboardPasteBinding({
      target: host,
      onFiles: (paste) => {
        claimFocus();
        recordFiles('tty', paste);
      },
      onCtrlV: (data) => {
        claimFocus();
        terminal.input(data);
      },
    });
    const formPaste = createTerminalClipboardPasteBinding({
      target: textarea,
      onFiles: (paste) => recordFiles('form', paste),
    });
    textarea.addEventListener('keydown', formPaste.handleKeyEvent, true);
    textarea.addEventListener('keyup', formPaste.handleKeyEvent, true);
    const ctrlCSelection = createCtrlCSelectionBinding({
      terminal,
      enabled: true,
      beforeKeyEvent: ttyPaste.handleKeyEvent,
      onClipboardBlocked: (error) => clipboardFailures.push(String(error)),
    });
    const inputIntent = createTerminalInputIntentBinding({
      terminal,
      container: host,
      onInputIntent: claimFocus,
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
      inputTrace: () => inputTrace.slice(),
      domInputTrace: () => domInputTrace.slice(),
      keyTrace: () => keyTrace.slice(),
      keydownTrace: () => keydownTrace.slice(),
      resetInputTrace: () => {
        inputTrace.length = 0;
        domInputTrace.length = 0;
        keyTrace.length = 0;
      },
      prepareCtrlCSelection: async (text) => {
        terminal.clearSelection();
        await write(`\r\n${text}`);
        const row = terminal.buffer.active.baseY + terminal.buffer.active.cursorY;
        terminal.select(0, row, text.length);
        return terminal.getSelection();
      },
      copyTrace: () => copyTrace.slice(),
      clipboardFailures: () => clipboardFailures.slice(),
      hasSelection: () => terminal.hasSelection(),
      focusTerminal: () => terminal.focus(),
      filePastes: () => Promise.all(filePastes),
      pasteFiles: (files, text) => {
        const clipboardData = new DataTransfer();
        for (const { name, bytes } of files) {
          clipboardData.items.add(new File([new Uint8Array(bytes)], name));
        }
        clipboardData.setData('text/plain', text);
        const target = document.activeElement;
        const pasted = target.dispatchEvent(
          new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
        clipboardData.items.clear();
        return pasted;
      },
      enableDecFocusReporting: () => write('\x1b[?1004h'),
      setBracketedPaste: (enabled) => write(enabled ? '\x1b[?2004h' : '\x1b[?2004l'),
      cycleProgrammaticFocus: () => {
        terminal.blur();
        terminal.focus();
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
        ttyPaste.dispose();
        formPaste.dispose();
        textarea.removeEventListener('keydown', formPaste.handleKeyEvent, true);
        textarea.removeEventListener('keyup', formPaste.handleKeyEvent, true);
        ctrlCSelection.dispose();
        inputIntent.dispose();
        controller.dispose();
        terminal.dispose();
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

  const assertFocusBeforeInput = (label, trace, expectedData) => {
    const focusIndex = trace.findIndex(({ marker }) => marker === 'focus');
    const inputIndex = trace.findIndex(
      ({ marker, data }) =>
        marker === 'input' && (expectedData === undefined || data === expectedData),
    );
    if (focusIndex < 0) throw new Error(`${label} did not record an input-intent focus marker`);
    if (inputIndex < 0) {
      throw new Error(`${label} did not reach xterm onData: ${JSON.stringify(trace)}`);
    }
    if (focusIndex >= inputIndex) {
      throw new Error(`${label} expected focus before input, got ${JSON.stringify(trace)}`);
    }
  };

  const assertNoCtrlCLeak = (label, input, keys) => {
    if (input.some(({ marker, data }) => marker === 'input' && data === '\x03')) {
      throw new Error(`${label} leaked ETX: ${JSON.stringify(input)}`);
    }
    if (keys.length > 0) {
      throw new Error(`${label} leaked onKey: ${JSON.stringify(keys)}`);
    }
  };

  // --- Input phase 1: trusted physical key emits intent before xterm onData ---
  await smoke(() => window.__xterm6Smoke.focusTerminal());
  await smoke(() => window.__xterm6Smoke.resetInputTrace());
  await page.keyboard.press('KeyK');
  await settle();
  const physicalKey = {
    trace: await smoke(() => window.__xterm6Smoke.inputTrace()),
    keys: await smoke(() => window.__xterm6Smoke.keyTrace()),
  };
  assertFocusBeforeInput('Trusted physical key', physicalKey.trace, 'k');
  if (!physicalKey.keys.some(({ key, trusted }) => key === 'k' && trusted)) {
    throw new Error(
      `Physical key did not reach trusted xterm onKey: ${JSON.stringify(physicalKey.keys)}`,
    );
  }

  // --- Input phase 2: trusted clipboard paste emits intent before pasted onData ---
  const pastedText = 'trusted-paste';
  await smoke(() => window.__xterm6Smoke.resetInputTrace());
  await page.evaluate((text) => navigator.clipboard.writeText(text), pastedText);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+Shift+V');
  await settle();
  const clipboardPaste = {
    trace: await smoke(() => window.__xterm6Smoke.inputTrace()),
    dom: await smoke(() => window.__xterm6Smoke.domInputTrace()),
  };
  assertFocusBeforeInput('Trusted clipboard paste', clipboardPaste.trace, pastedText);
  if (!clipboardPaste.dom.some(({ type, trusted }) => type === 'paste' && trusted)) {
    throw new Error(
      `Clipboard shortcut did not produce a trusted paste: ${JSON.stringify(clipboardPaste.dom)}`,
    );
  }

  const getInput = async () =>
    (await smoke(() => window.__xterm6Smoke.inputTrace()))
      .filter(({ marker }) => marker === 'input')
      .map(({ data }) => data);
  if (process.platform !== 'darwin') {
    await smoke(() => window.__xterm6Smoke.setBracketedPaste(true));
    for (const [text, expected] of [
      ['first\n  second', '\x1b[200~first\r  second\x1b[201~'],
      ['', '\x16'],
    ]) {
      await smoke(() => window.__xterm6Smoke.resetInputTrace());
      await page.evaluate((value) => navigator.clipboard.writeText(value), text);
      await page.keyboard.press('Control+V');
      await page.waitForTimeout(200);
      const trace = await smoke(() => window.__xterm6Smoke.inputTrace());
      assertFocusBeforeInput('Ctrl+V', trace, expected);
      if (trace.filter(({ marker }) => marker === 'input').length !== 1) {
        throw new Error(`Ctrl+V produced extra input: ${JSON.stringify(trace)}`);
      }
    }
    await smoke(() => window.__xterm6Smoke.setBracketedPaste(false));
  }

  // Use a native clipboard write for a real File and dispatch a multi-file DataTransfer to
  // exercise browser payloads Chromium cannot write to the clipboard as separate entries.
  await smoke(() => window.__xterm6Smoke.resetInputTrace());
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const png = await new Promise((resolve) => canvas.toBlob(resolve));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  });
  const pasteShortcut = process.platform === 'darwin' ? 'Meta+V' : 'Control+V';
  await page.keyboard.press(pasteShortcut);
  await page.waitForTimeout(200);
  const nativePaste = await smoke(() => window.__xterm6Smoke.filePastes());
  const nativePasteEvents = await smoke(() => window.__xterm6Smoke.domInputTrace());
  if (
    nativePaste.length !== 1 ||
    nativePaste[0].count !== 1 ||
    nativePaste[0].images[0]?.mimeType !== 'image/png' ||
    !nativePasteEvents.some(({ type, trusted }) => type === 'paste' && trusted) ||
    (await getInput()).length !== 0
  ) {
    throw new Error(
      `Ordinary paste did not capture exactly one native image: ${JSON.stringify(nativePaste)}`,
    );
  }

  const png = { name: 'first.png', bytes: [137, 80, 78, 71, 13, 10, 26, 10, 1] };
  const jpeg = { name: 'second.jpg', bytes: [255, 216, 255, 224, 2] };
  const invalid = { name: 'third.txt', bytes: [1, 2, 3] };
  const files = [png, invalid, jpeg];
  const pasteFiles = () =>
    smoke((entries) => window.__xterm6Smoke.pasteFiles(entries, 'text fallback'), files);
  if (await pasteFiles()) throw new Error('Terminal Files-plus-text paste was not consumed');
  const formInput = page.locator('#form-input');
  await formInput.focus();
  if (await pasteFiles()) throw new Error('Form Files-plus-text paste was not consumed');
  const clipboardFiles = await smoke(() => window.__xterm6Smoke.filePastes());
  for (const [index, target] of ['tty', 'form'].entries()) {
    const paste = clipboardFiles[index + 1];
    const captured = paste?.images.map(({ name, bytes }) => ({ name, bytes }));
    if (
      paste?.target !== target ||
      paste.count !== 3 ||
      paste.unsupportedFileCount !== 1 ||
      JSON.stringify(captured) !== JSON.stringify([png, jpeg])
    ) {
      throw new Error(`Wrong file count, bytes, or order for ${target}: ${JSON.stringify(paste)}`);
    }
  }
  if ((await getInput()).length !== 0 || (await formInput.inputValue()) !== '') {
    throw new Error('Files-plus-text paste leaked fallback text');
  }
  await page.evaluate((value) => navigator.clipboard.writeText(value), pastedText);
  await page.keyboard.press(pasteShortcut);
  if ((await formInput.inputValue()) !== pastedText)
    throw new Error('Form did not paste text natively');
  await smoke(() => window.__xterm6Smoke.focusTerminal());

  // --- Input phase 3: Chromium trusted text insertion exposes beforeinput coupling ---
  const insertedText = 'trusted-insert';
  await smoke(() => window.__xterm6Smoke.resetInputTrace());
  await page.keyboard.insertText(insertedText);
  await settle();
  const textInsertion = {
    trace: await smoke(() => window.__xterm6Smoke.inputTrace()),
    dom: await smoke(() => window.__xterm6Smoke.domInputTrace()),
  };
  assertFocusBeforeInput('Trusted text insertion', textInsertion.trace, insertedText);
  if (!textInsertion.dom.some(({ type, trusted }) => type === 'beforeinput' && trusted)) {
    throw new Error(
      `Chromium text insertion did not expose trusted beforeinput: ${JSON.stringify(textInsertion.dom)}`,
    );
  }

  // --- Input phase 4: DEC focus reports reach onData without claiming input intent ---
  await smoke(() => window.__xterm6Smoke.enableDecFocusReporting());
  await smoke(() => window.__xterm6Smoke.resetInputTrace());
  await smoke(() => window.__xterm6Smoke.cycleProgrammaticFocus());
  await settle();
  const decFocus = { trace: await smoke(() => window.__xterm6Smoke.inputTrace()) };
  const decInput = decFocus.trace
    .filter(({ marker }) => marker === 'input')
    .map(({ data }) => data)
    .join('');
  if (decFocus.trace.some(({ marker }) => marker === 'focus')) {
    throw new Error(
      `Programmatic DEC focus cycle stole input authority: ${JSON.stringify(decFocus.trace)}`,
    );
  }
  if (decInput !== '\x1b[O\x1b[I') {
    throw new Error(
      `Programmatic DEC focus cycle expected ESC[O then ESC[I onData, got ${JSON.stringify(decInput)}`,
    );
  }

  // --- Input phase 5: trusted selected Ctrl+C owns the physical gesture until keyup ---
  const copiedText = 'trusted-ctrl-c-selection';
  const initialSentinel = 'clipboard-before-selected-copy';
  const repeatSentinel = 'clipboard-must-survive-repeat';
  const selectedText = await smoke(
    (text) => window.__xterm6Smoke.prepareCtrlCSelection(text),
    copiedText,
  );
  if (selectedText !== copiedText) {
    throw new Error(`xterm selection setup mismatch: ${JSON.stringify(selectedText)}`);
  }
  await page.evaluate((text) => navigator.clipboard.writeText(text), initialSentinel);
  await smoke(() => window.__xterm6Smoke.resetInputTrace());
  await page.keyboard.down('Control');
  await page.keyboard.down('KeyC');
  await settle();
  const firstCtrlC = {
    clipboard: await page.evaluate(() => navigator.clipboard.readText()),
    copyTrace: await smoke(() => window.__xterm6Smoke.copyTrace()),
    selectionCleared: !(await smoke(() => window.__xterm6Smoke.hasSelection())),
    input: await smoke(() => window.__xterm6Smoke.inputTrace()),
    keys: await smoke(() => window.__xterm6Smoke.keyTrace()),
  };
  if (firstCtrlC.clipboard !== copiedText) {
    throw new Error(
      `Selected Ctrl+C expected ${JSON.stringify(copiedText)}, got ${JSON.stringify(firstCtrlC.clipboard)}`,
    );
  }
  if (
    firstCtrlC.copyTrace.length !== 1 ||
    firstCtrlC.copyTrace[0].served !== true ||
    firstCtrlC.copyTrace[0].selectionPresent !== true
  ) {
    throw new Error(
      `Selected Ctrl+C expected one served copy event before clear: ${JSON.stringify(firstCtrlC.copyTrace)}`,
    );
  }
  if (!firstCtrlC.selectionCleared) {
    throw new Error('Selected Ctrl+C did not clear selection in the following macrotask');
  }
  assertNoCtrlCLeak('Selected Ctrl+C', firstCtrlC.input, firstCtrlC.keys);

  await page.evaluate((text) => navigator.clipboard.writeText(text), repeatSentinel);
  await page.keyboard.down('KeyC');
  await settle();
  const repeatedCtrlC = {
    clipboard: await page.evaluate(() => navigator.clipboard.readText()),
    copyTrace: await smoke(() => window.__xterm6Smoke.copyTrace()),
    input: await smoke(() => window.__xterm6Smoke.inputTrace()),
    keys: await smoke(() => window.__xterm6Smoke.keyTrace()),
    keydowns: (await smoke(() => window.__xterm6Smoke.keydownTrace())).filter(
      ({ keyCode }) => keyCode === 67,
    ),
  };
  if (repeatedCtrlC.clipboard !== repeatSentinel) {
    throw new Error(
      `Held Ctrl+C repeat changed the clipboard: ${JSON.stringify(repeatedCtrlC.clipboard)}`,
    );
  }
  if (repeatedCtrlC.copyTrace.length !== 1) {
    throw new Error(
      `Held Ctrl+C repeat produced another copy event: ${JSON.stringify(repeatedCtrlC.copyTrace)}`,
    );
  }
  if (!repeatedCtrlC.keydowns.some(({ repeat, trusted }) => repeat && trusted)) {
    throw new Error(
      `Held Ctrl+C did not produce a trusted repeat keydown: ${JSON.stringify(repeatedCtrlC.keydowns)}`,
    );
  }
  assertNoCtrlCLeak('Held Ctrl+C repeat', repeatedCtrlC.input, repeatedCtrlC.keys);

  await page.keyboard.up('KeyC');
  await page.keyboard.up('Control');
  await page.keyboard.press('Control+KeyC');
  await settle();
  const afterKeyup = {
    input: await smoke(() => window.__xterm6Smoke.inputTrace()),
    clipboardFailures: await smoke(() => window.__xterm6Smoke.clipboardFailures()),
  };
  if (!afterKeyup.input.some(({ marker, data }) => marker === 'input' && data === '\x03')) {
    throw new Error(`Ctrl+C after keyup did not emit ETX: ${JSON.stringify(afterKeyup.input)}`);
  }
  if (afterKeyup.clipboardFailures.length > 0) {
    throw new Error(
      `Selected Ctrl+C unexpectedly used a failing fallback: ${JSON.stringify(afterKeyup.clipboardFailures)}`,
    );
  }
  const ctrlCSelection = {
    copiedText,
    initialSentinel,
    repeatSentinel,
    firstCtrlC,
    repeatedCtrlC,
    afterKeyup,
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
    physicalKey,
    clipboardPaste,
    clipboardFilePastes: clipboardFiles.map(({ target, count, images }) => ({
      target,
      count,
      images: images.length,
    })),
    textInsertion,
    decFocus,
    ctrlCSelection,
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
