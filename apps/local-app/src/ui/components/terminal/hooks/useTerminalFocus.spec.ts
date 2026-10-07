import { renderHook } from '@testing-library/react';
import { useTerminalFocus } from './useTerminalFocus';
import { FOCUS_INTENT_STALE_MS } from '../focus-intent';

interface MockSocket {
  emit: jest.Mock;
  connected: boolean;
}

function setup(opts?: { connected?: boolean; subscribed?: boolean }) {
  const host = document.createElement('div');
  document.body.appendChild(host);

  const socket: MockSocket = { emit: jest.fn(), connected: opts?.connected ?? true };
  const containerRef = { current: host } as React.RefObject<HTMLDivElement>;
  const isSubscribedRef = { current: opts?.subscribed ?? true } as React.MutableRefObject<boolean>;

  const rendered = renderHook(() =>
    useTerminalFocus(containerRef, 'session-1', isSubscribedRef, socket as never),
  );

  return { host, socket, isSubscribedRef, rendered };
}

/** A user gesture landing on `target` (defaults to document.body — i.e. OUTSIDE the host). */
function dispatchGesture(type: 'pointerdown' | 'keydown', target: EventTarget = document.body) {
  target.dispatchEvent(new Event(type, { bubbles: true }));
}

function dispatchFocusIn(host: HTMLElement) {
  host.dispatchEvent(new Event('focusin', { bubbles: true }));
}

afterEach(() => {
  document.body.innerHTML = '';
  jest.useRealTimers();
});

describe('useTerminalFocus — entry vectors claim authority', () => {
  it.each([
    ['pointerdown', true],
    ['pointerdown', false],
    ['keydown', false],
  ] as const)('claims authority after %s inside=%s', (gesture, inside) => {
    const { host, socket } = setup();

    dispatchGesture(gesture, inside ? host : document.body);
    dispatchFocusIn(host);

    expect(socket.emit.mock.calls).toEqual([['terminal:focus', { sessionId: 'session-1' }]]);
  });
});

describe('useTerminalFocus — programmatic focus does not steal', () => {
  it('floating-window handle.focus() (focusin with no gesture) does NOT claim', () => {
    const { host, socket } = setup();

    dispatchFocusIn(host);
    dispatchFocusIn(host); // repeated programmatic focus is still no-op

    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('a gesture that has decayed past the stale window does NOT authorize a later programmatic focus', () => {
    jest.useFakeTimers();
    const { host, socket } = setup();

    dispatchGesture('pointerdown', host);
    jest.advanceTimersByTime(FOCUS_INTENT_STALE_MS + 1);
    dispatchFocusIn(host);

    expect(socket.emit).not.toHaveBeenCalled();
  });
});

describe('useTerminalFocus — preconditions and teardown', () => {
  it.each([{ connected: false }, { subscribed: false }])(
    'blocks focus claims with %p',
    (options) => {
      const { host, socket } = setup(options);

      dispatchGesture('pointerdown', host);
      dispatchFocusIn(host);

      expect(socket.emit).not.toHaveBeenCalled();
    },
  );

  it('removes document and host listeners on unmount', () => {
    const { host, socket, rendered } = setup();

    rendered.unmount();

    dispatchGesture('pointerdown', host);
    dispatchFocusIn(host);

    expect(socket.emit).not.toHaveBeenCalled();
  });
});
