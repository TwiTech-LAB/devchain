import { createScrollIntentBinding, type ScrollIntentController } from './scroll-intent-binding';

/**
 * Test layer: pure unit (jsdom). The seam is DOM-only glue with no xterm, socket, or React —
 * dispatching real capture-phase events on a container and asserting the intent-stamp callback
 * and drag lifecycle proves the routing (which events stamp, which scrollbar path drags, how a
 * drag ends) at the cheapest layer. Real-browser trusted-event behavior is proven separately by
 * the xterm 6 Chromium smoke; this file makes no claim about it.
 */
describe('createScrollIntentBinding', () => {
  let container: HTMLElement;
  let stampIntent: jest.Mock;
  let mouseTrackingMode: string;
  let ttyMode: boolean;
  let nowValue: number;
  let controller: ScrollIntentController;

  function bind() {
    controller = createScrollIntentBinding({
      container,
      stampIntent,
      getMouseTrackingMode: () => mouseTrackingMode,
      isTtyMode: () => ttyMode,
      now: () => nowValue,
    });
    return controller;
  }

  /** Build the xterm 6 scrollbar subtree and return its parts. */
  function buildScrollbar() {
    const scrollable = document.createElement('div');
    scrollable.className = 'xterm-scrollable-element';
    const scrollbar = document.createElement('div');
    scrollbar.className = 'scrollbar vertical';
    const slider = document.createElement('div');
    slider.className = 'slider';
    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    scrollbar.appendChild(slider);
    scrollable.appendChild(scrollbar);
    scrollable.appendChild(screen);
    container.appendChild(scrollable);
    return { scrollbar, slider, screen };
  }

  function wheel(deltaY: number): WheelEvent {
    return new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
  }
  function key(code: string, shiftKey: boolean): KeyboardEvent {
    return new KeyboardEvent('keydown', { code, shiftKey, bubbles: true, cancelable: true });
  }
  function pointer(type: string): Event {
    // jsdom has no PointerEvent constructor; a generic bubbling/cancelable Event carries the
    // target + composedPath the seam reads.
    return new Event(type, { bubbles: true, cancelable: true });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    stampIntent = jest.fn();
    mouseTrackingMode = 'none';
    ttyMode = false;
    nowValue = 10_000;
    bind();
  });

  afterEach(() => {
    controller.dispose();
    container.remove();
  });

  describe('wheel observation', () => {
    it.each([
      { delta: -120, tty: false, tracking: 'none', stamps: 1 },
      { delta: 120, tty: false, tracking: 'none', stamps: 0 },
      { delta: -120, tty: true, tracking: 'any', stamps: 0 },
      { delta: -120, tty: true, tracking: 'x10', stamps: 1 },
      { delta: -120, tty: false, tracking: 'any', stamps: 1 },
    ] as const)(
      'observes wheel $delta tty=$tty tracking=$tracking',
      ({ delta, tty, tracking, stamps }) => {
        ttyMode = tty;
        mouseTrackingMode = tracking;
        const event = wheel(delta);
        container.dispatchEvent(event);
        expect(stampIntent).toHaveBeenCalledTimes(stamps);
        if (stamps) expect(stampIntent).toHaveBeenCalledWith(nowValue);
        expect(event.defaultPrevented).toBe(false);
      },
    );
  });

  describe('keyboard observation', () => {
    it.each(['PageUp', 'PageDown'])('stamps intent on Shift+%s', (code) => {
      container.dispatchEvent(key(code, true));
      expect(stampIntent).toHaveBeenCalledTimes(1);
    });

    it('does not stamp on unmodified PageUp (a shell key sequence)', () => {
      container.dispatchEvent(key('PageUp', false));
      expect(stampIntent).not.toHaveBeenCalled();
    });
  });

  describe('scrollbar pointerdown routing', () => {
    it.each(['slider', 'scrollbar'] as const)('begins drag on %s', (target) => {
      const node = buildScrollbar()[target];
      node.dispatchEvent(pointer('pointerdown'));
      expect(stampIntent).toHaveBeenCalledTimes(1);
      expect(controller.isDragActive()).toBe(true);
    });

    it('does not stamp or drag on terminal-content selection', () => {
      const { screen } = buildScrollbar();
      screen.dispatchEvent(pointer('pointerdown'));
      expect(stampIntent).not.toHaveBeenCalled();
      expect(controller.isDragActive()).toBe(false);
    });
  });

  describe('drag lifecycle', () => {
    it('refreshes intent on pointermove while dragging and ends cleanly on pointerup', () => {
      const ends: string[] = [];
      controller.onDragEnd((reason) => ends.push(reason));
      const { slider } = buildScrollbar();

      slider.dispatchEvent(pointer('pointerdown')); // stamp #1, drag active
      nowValue = 12_500; // slow drag past the decay window
      window.dispatchEvent(pointer('pointermove')); // stamp #2 (refresh)
      expect(stampIntent).toHaveBeenCalledTimes(2);
      expect(stampIntent).toHaveBeenLastCalledWith(12_500);

      window.dispatchEvent(pointer('pointerup'));
      expect(controller.isDragActive()).toBe(false);
      expect(ends).toEqual(['pointerup']);

      // Listeners are torn down at drag end: a later pointermove no longer refreshes.
      window.dispatchEvent(pointer('pointermove'));
      expect(stampIntent).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['pointercancel', 'pointercancel'],
      ['lostpointercapture', 'capture-loss'],
    ] as const)('ends drag on %s', (event, reason) => {
      const ends: string[] = [];
      controller.onDragEnd((reason) => ends.push(reason));
      const { slider } = buildScrollbar();
      slider.dispatchEvent(pointer('pointerdown'));
      (event === 'pointercancel' ? window : document).dispatchEvent(pointer(event));
      expect(controller.isDragActive()).toBe(false);
      expect(ends).toEqual([reason]);
    });

    it('does not refresh intent from an unrelated pointermove when no drag is active', () => {
      window.dispatchEvent(pointer('pointermove'));
      expect(stampIntent).not.toHaveBeenCalled();
    });

    it('stops notifying an unsubscribed drag-end listener', () => {
      const listener = jest.fn();
      const unsubscribe = controller.onDragEnd(listener);
      const { slider } = buildScrollbar();
      slider.dispatchEvent(pointer('pointerdown'));
      unsubscribe();
      window.dispatchEvent(pointer('pointerup'));
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('detaches every listener so later events do not stamp or drag', () => {
      const { slider } = buildScrollbar();
      controller.dispose();

      container.dispatchEvent(wheel(-120));
      container.dispatchEvent(key('PageUp', true));
      slider.dispatchEvent(pointer('pointerdown'));

      expect(stampIntent).not.toHaveBeenCalled();
      expect(controller.isDragActive()).toBe(false);
    });

    it('tears down an in-progress drag on dispose', () => {
      const { slider } = buildScrollbar();
      slider.dispatchEvent(pointer('pointerdown'));
      expect(controller.isDragActive()).toBe(true);

      controller.dispose();
      expect(controller.isDragActive()).toBe(false);

      // The window drag listeners are gone: a stray pointermove must not stamp.
      stampIntent.mockClear();
      window.dispatchEvent(pointer('pointermove'));
      expect(stampIntent).not.toHaveBeenCalled();
    });
  });
});
