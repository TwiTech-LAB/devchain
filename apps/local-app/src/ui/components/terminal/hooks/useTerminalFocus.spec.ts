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
  it('direct terminal click (pointerdown) then focusin claims authority', () => {
    const { host, socket } = setup();

    dispatchGesture('pointerdown', host);
    dispatchFocusIn(host);

    expect(socket.emit).toHaveBeenCalledWith('terminal:focus', { sessionId: 'session-1' });
  });

  it('floating-window / tab click (pointerdown OUTSIDE the host) then focusin claims authority', () => {
    const { host, socket } = setup();

    // The click that transfers focus lands on window chrome / a tab button, not the terminal host.
    dispatchGesture('pointerdown', document.body);
    dispatchFocusIn(host);

    expect(socket.emit).toHaveBeenCalledWith('terminal:focus', { sessionId: 'session-1' });
  });

  it('keyboard Tab (keydown originating OUTSIDE the host) then focusin claims authority', () => {
    const { host, socket } = setup();

    // Tab keydown fires on the previously-focused element — the document-level listener still stamps.
    dispatchGesture('keydown', document.body);
    dispatchFocusIn(host);

    expect(socket.emit).toHaveBeenCalledWith('terminal:focus', { sessionId: 'session-1' });
  });

  it('claim is emitted on focusin BEFORE any input byte (claim-before-input invariant)', () => {
    const { host, socket } = setup();

    dispatchGesture('keydown', document.body);
    dispatchFocusIn(host);

    // The only emit so far is the authority claim — it precedes the terminal:input path entirely,
    // so the first typed byte is delivered with authority already held.
    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenLastCalledWith('terminal:focus', { sessionId: 'session-1' });
  });
});

describe('useTerminalFocus — programmatic focus does not steal', () => {
  it('panel re-show fit()+focus() (focusin with no preceding gesture) does NOT claim', () => {
    const { host, socket } = setup();

    // No pointerdown/keydown precedes this focusin — it is a bare programmatic .focus().
    dispatchFocusIn(host);

    expect(socket.emit).not.toHaveBeenCalled();
  });

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
  it('does not claim when the socket is disconnected', () => {
    const { host, socket } = setup({ connected: false });

    dispatchGesture('pointerdown', host);
    dispatchFocusIn(host);

    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('does not claim when the client is not subscribed', () => {
    const { host, socket } = setup({ subscribed: false });

    dispatchGesture('pointerdown', host);
    dispatchFocusIn(host);

    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('removes document and host listeners on unmount', () => {
    const { host, socket, rendered } = setup();

    rendered.unmount();

    dispatchGesture('pointerdown', host);
    dispatchFocusIn(host);

    expect(socket.emit).not.toHaveBeenCalled();
  });
});
