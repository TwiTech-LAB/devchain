import { act, renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import {
  useAgentEventBusLayout,
  type AgentEventBusLayoutEnvironment,
} from './useAgentEventBusLayout';

// Layer: UI hook unit (jsdom). renderHook with injected observer/rAF seams and
// controlled DOMRect values is the cheapest reliable proof of registration,
// batching, and stale-callback rejection; real layout is covered in Playwright.
function setRect(
  element: Element,
  rect: Partial<DOMRect> & Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
) {
  const completeRect = {
    x: rect.left,
    y: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    toJSON: () => undefined,
    ...rect,
  } as DOMRect;
  jest.spyOn(element, 'getBoundingClientRect').mockImplementation(() => completeRect);
}

function createLayoutEnvironment() {
  let nextFrame = 1;
  const frames = new Map<number, { callback: FrameRequestCallback; executed: boolean }>();
  const cancelledFrames = new Set<number>();
  const observers: FakeResizeObserver[] = [];

  class FakeResizeObserver implements ResizeObserver {
    readonly observed = new Set<Element>();
    readonly callback: ResizeObserverCallback;
    disconnected = false;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      observers.push(this);
    }

    observe(target: Element) {
      this.observed.add(target);
    }

    unobserve(target: Element) {
      this.observed.delete(target);
    }

    disconnect() {
      this.disconnected = true;
      this.observed.clear();
    }

    trigger() {
      this.callback([], this);
    }
  }

  const environment: AgentEventBusLayoutEnvironment = {
    createResizeObserver: (callback) => new FakeResizeObserver(callback),
    requestFrame: (callback) => {
      const handle = nextFrame++;
      frames.set(handle, { callback, executed: false });
      return handle;
    },
    cancelFrame: (handle) => {
      cancelledFrames.add(handle);
    },
  };

  return {
    environment,
    observers,
    pendingHandles: () =>
      [...frames.entries()]
        .filter(([, frame]) => !frame.executed)
        .map(([handle]) => handle)
        .filter((handle) => !cancelledFrames.has(handle)),
    flush(handle: number, force = false) {
      const frame = frames.get(handle);
      if (!frame || (!force && cancelledFrames.has(handle))) return;
      frame.executed = true;
      act(() => frame.callback(0));
    },
  };
}

describe('useAgentEventBusLayout', () => {
  it('registers callback refs, uses one observer, DOM order, and one batched rAF measurement', () => {
    const container = document.createElement('div');
    const first = document.createElement('span');
    const second = document.createElement('span');
    container.append(first, second);
    document.body.append(container);
    setRect(container, { left: 100, top: 50, width: 320, height: 400 });
    setRect(first, { left: 140, top: 100, width: 240, height: 40 });
    setRect(second, { left: 142, top: 180, width: 220, height: 40 });
    const harness = createLayoutEnvironment();
    const containerRef = { current: container } as RefObject<HTMLElement>;
    const { result, unmount } = renderHook(() =>
      useAgentEventBusLayout({
        containerRef,
        scopeEpoch: 1,
        environment: harness.environment,
      }),
    );

    act(() => {
      result.current.getAnchorRef({ key: 'second', agentId: 'agent-2' })(second);
      result.current.getAnchorRef({ key: 'first', agentId: 'agent-1' })(first);
      harness.observers[0].trigger();
      harness.observers[0].trigger();
    });

    expect(harness.observers).toHaveLength(1);
    expect(harness.pendingHandles()).toHaveLength(1);
    harness.flush(harness.pendingHandles()[0]);

    expect(result.current.geometry?.anchors.map((anchor) => anchor.key)).toEqual([
      'first',
      'second',
    ]);
    expect(result.current.geometry?.anchors[0]).toMatchObject({ x: 40, y: 70, order: 0 });
    expect(result.current.geometry?.anchors[1]).toMatchObject({ x: 42, y: 150, order: 1 });
    expect(result.current.geometry?.anchors[0].x).not.toBe(160);
    expect(result.current.geometry).toMatchObject({
      scopeEpoch: 1,
      width: 320,
      height: 400,
      busX: 4,
      runtimeOrigin: { kind: 'runtime', x: 4, y: 8 },
    });
    expect(harness.observers[0].observed).toEqual(new Set([container, second, first]));

    unmount();
    expect(harness.observers[0].disconnected).toBe(true);
    container.remove();
  });

  it('invalidates geometry on scope change and rejects a cancelled stale rAF callback', () => {
    const container = document.createElement('div');
    const endpoint = document.createElement('span');
    container.append(endpoint);
    document.body.append(container);
    setRect(container, { left: 0, top: 0, width: 200, height: 240 });
    setRect(endpoint, { left: 40, top: 60, width: 8, height: 8 });
    const harness = createLayoutEnvironment();
    const containerRef = { current: container } as RefObject<HTMLElement>;
    const { result, rerender, unmount } = renderHook(
      ({ scopeEpoch }) =>
        useAgentEventBusLayout({
          containerRef,
          scopeEpoch,
          environment: harness.environment,
        }),
      { initialProps: { scopeEpoch: 1 } },
    );
    act(() => {
      result.current.getAnchorRef({ key: 'endpoint', agentId: 'agent' })(endpoint);
    });
    harness.flush(harness.pendingHandles()[0]);
    expect(result.current.geometry?.scopeEpoch).toBe(1);

    act(() => harness.observers[0].trigger());
    const staleHandle = harness.pendingHandles()[0];
    rerender({ scopeEpoch: 2 });

    expect(result.current.geometry).toBeNull();
    harness.flush(staleHandle, true);
    expect(result.current.geometry).toBeNull();

    const freshHandle = harness.pendingHandles()[0];
    harness.flush(freshHandle);
    expect(result.current.geometry?.scopeEpoch).toBe(2);
    expect(result.current.geometry?.geometryEpoch).toBeGreaterThan(1);

    unmount();
    container.remove();
  });
});
