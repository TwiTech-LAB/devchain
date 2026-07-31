import { act, fireEvent, render, screen, waitFor, type RenderResult } from '@testing-library/react';
import { useCallback, useRef, type RefCallback } from 'react';
import type { Socket } from 'socket.io-client';
import { AgentEventBus, useAgentEventBusAnchor } from './AgentEventBus';
import { EVENT_BUS_ROUTE_DURATION_MS } from './geometry';
import { EVENT_BUS_REDUCE_MOTION_STORAGE_KEY, readAgentEventBusReduceMotion } from './preference';
import type { AgentEventBusSchedulerEnvironment } from './scheduler';
import type { AgentEventBusAnimationDriver, AgentEventBusAnimationHandle } from './types';
import type { AgentEventBusLayoutEnvironment } from './useAgentEventBusLayout';
import type { AgentEventBusStreamFrame, AgentMessageEventFrame } from './useAgentEventBusStream';

// Layer: UI component (jsdom). Rendering with controlled stream, geometry,
// timer, and animation seams is the cheapest reliable proof of React lifecycle,
// SVG state, feedback priority, and cleanup; browser layout/hit-testing stays E2E.
interface GlobalWithDOMRect extends Global {
  DOMRect?: typeof DOMRect;
}

if (!(global as GlobalWithDOMRect).DOMRect) {
  (global as GlobalWithDOMRect).DOMRect = class DOMRect {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    left: number;
    right: number;
    bottom: number;

    constructor(x = 0, y = 0, width = 0, height = 0) {
      this.x = x;
      this.y = y;
      this.width = width;
      this.height = height;
      this.top = y;
      this.left = x;
      this.right = x + width;
      this.bottom = y + height;
    }

    toJSON() {
      return this;
    }

    static fromRect(rect: Partial<{ x: number; y: number; width: number; height: number }> = {}) {
      const { x = 0, y = 0, width = 0, height = 0 } = rect;
      return new DOMRect(x, y, width, height);
    }
  };
}

let mockSelectedSocket = {} as Socket;
let mockStreamHandler: ((frame: AgentEventBusStreamFrame) => void) | null = null;

jest.mock('./useAgentEventBusStream', () => ({
  useAgentEventBusStream: (
    _projectId: string | null | undefined,
    handler: (frame: AgentEventBusStreamFrame) => void,
  ) => {
    mockStreamHandler = handler;
    return mockSelectedSocket;
  },
}));

type TimerHandle = ReturnType<typeof setTimeout>;

function setRect(
  element: Element,
  { left, top, width, height }: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
) {
  element.getBoundingClientRect = jest.fn(
    () =>
      ({
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        toJSON: () => undefined,
      }) as DOMRect,
  );
}

function createLayoutHarness() {
  let nextFrame = 1;
  const frames = new Map<number, { callback: FrameRequestCallback; cancelled: boolean }>();
  const observers: FakeResizeObserver[] = [];

  class FakeResizeObserver implements ResizeObserver {
    readonly callback: ResizeObserverCallback;
    disconnected = false;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      observers.push(this);
    }

    observe() {}
    unobserve() {}
    disconnect() {
      this.disconnected = true;
    }
    trigger() {
      this.callback([], this);
    }
  }

  const environment: AgentEventBusLayoutEnvironment = {
    createResizeObserver: (callback) => new FakeResizeObserver(callback),
    requestFrame: (callback) => {
      const handle = nextFrame++;
      frames.set(handle, { callback, cancelled: false });
      return handle;
    },
    cancelFrame: (handle) => {
      const frame = frames.get(handle);
      if (frame) frame.cancelled = true;
    },
  };

  return {
    environment,
    observers,
    flushAll() {
      for (let pass = 0; pass < 20; pass += 1) {
        const pending = [...frames.values()].filter(
          (frame) => !frame.cancelled && !('executed' in frame),
        );
        if (pending.length === 0) return;
        for (const frame of pending) {
          Object.assign(frame, { executed: true });
          act(() => frame.callback(0));
        }
      }
      throw new Error('layout frame queue did not settle');
    },
    snapshotCallbacks() {
      return [...frames.values()].map((frame) => frame.callback);
    },
    forceCallbacks(callbacks: FrameRequestCallback[]) {
      for (const callback of callbacks) act(() => callback(0));
    },
  };
}

function createSchedulerHarness() {
  const timers: Array<{ callback: () => void; cleared: boolean; delayMs: number }> = [];
  const environment: AgentEventBusSchedulerEnvironment = {
    setTimer: (callback, delayMs) => {
      const timer = { callback, cleared: false, delayMs };
      timers.push(timer);
      return timers.length as unknown as TimerHandle;
    },
    clearTimer: (handle) => {
      const timer = timers[(handle as unknown as number) - 1];
      if (timer) timer.cleared = true;
    },
  };
  return {
    environment,
    timers,
    snapshotCallbacks() {
      return timers.map((timer) => timer.callback);
    },
    forceCallbacks(callbacks: Array<() => void>) {
      for (const callback of callbacks) act(() => callback());
    },
    runDelay(delayMs: number) {
      const pending = timers.filter((timer) => !timer.cleared && timer.delayMs === delayMs);
      for (const timer of pending) {
        timer.cleared = true;
        act(() => timer.callback());
      }
    },
  };
}

function createAnimationHarness() {
  const handles: Array<AgentEventBusAnimationHandle & { cancel: jest.Mock }> = [];
  const animate = jest.fn(() => {
    const handle = { cancel: jest.fn() };
    handles.push(handle);
    return handle;
  });
  return {
    driver: { animate } as AgentEventBusAnimationDriver,
    animate,
    handles,
  };
}

interface AnchorProps {
  anchorKey: string;
  agentId: string;
  top: number;
  teamId?: string;
}

function TestAnchor({ anchorKey, agentId, top, teamId }: AnchorProps) {
  const eventBusRef = useAgentEventBusAnchor({
    key: anchorKey,
    agentId,
    ...(teamId ? { teamId } : {}),
  });
  const ref = useCallback<RefCallback<HTMLSpanElement>>(
    (element) => {
      if (element) setRect(element, { left: 40, top, width: 240, height: 40 });
      eventBusRef(element);
    },
    [eventBusRef, top],
  );
  return <span ref={ref} data-testid={`anchor-${anchorKey}`} />;
}

interface HarnessProps {
  projectId: string;
  recipientTop?: number;
  showRecipient?: boolean;
  layoutEnvironment: AgentEventBusLayoutEnvironment;
  schedulerEnvironment: AgentEventBusSchedulerEnvironment;
  animationDriver: AgentEventBusAnimationDriver;
}

function BusHarness({
  projectId,
  recipientTop = 120,
  showRecipient = true,
  layoutEnvironment,
  schedulerEnvironment,
  animationDriver,
}: HarnessProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const setContainerRef = useCallback<RefCallback<HTMLDivElement>>((element) => {
    containerRef.current = element;
    if (element) setRect(element, { left: 0, top: 0, width: 320, height: 400 });
  }, []);

  return (
    <div ref={setContainerRef} style={{ position: 'relative' }}>
      <AgentEventBus
        projectId={projectId}
        containerRef={containerRef}
        layoutEnvironment={layoutEnvironment}
        schedulerEnvironment={schedulerEnvironment}
        animationDriver={animationDriver}
      >
        <TestAnchor anchorKey="sender" agentId="sender" top={40} />
        {showRecipient ? (
          <TestAnchor anchorKey="recipient" agentId="recipient" top={recipientTop} />
        ) : null}
      </AgentEventBus>
    </div>
  );
}

function directFrame(status: 'delivered' | 'failed' = 'delivered'): AgentMessageEventFrame {
  return {
    kind: 'agent-message',
    senderAgentId: 'sender',
    routingKind: 'direct',
    recipients: [{ agentId: 'recipient', status }],
  };
}

function renderBus(overrides: Partial<HarnessProps> = {}): RenderResult & {
  layout: ReturnType<typeof createLayoutHarness>;
  scheduler: ReturnType<typeof createSchedulerHarness>;
  animation: ReturnType<typeof createAnimationHarness>;
} {
  const layout = createLayoutHarness();
  const scheduler = createSchedulerHarness();
  const animation = createAnimationHarness();
  const rendered = render(
    <BusHarness
      projectId="project-1"
      layoutEnvironment={layout.environment}
      schedulerEnvironment={scheduler.environment}
      animationDriver={animation.driver}
      {...overrides}
    />,
  );
  layout.flushAll();
  return { ...rendered, layout, scheduler, animation };
}

describe('AgentEventBus', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockSelectedSocket = {} as Socket;
    mockStreamHandler = null;
  });

  it('renders an inert SVG, animates layered routes, rebuilds moved geometry, and drops lost endpoints', () => {
    const rendered = renderBus();
    const svg = screen.getByTestId('agent-event-bus-svg');

    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('pointer-events', 'none');
    expect(screen.getByTestId('agent-event-bus-control-lane')).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('agent-event-bus-control-lane')).toHaveAccessibleName(
      'Agent event bus controls',
    );
    expect(svg.querySelectorAll('.agent-event-bus__idle-anchor')).toHaveLength(2);

    act(() => mockStreamHandler?.(directFrame()));

    expect(svg.querySelectorAll('[data-route-animation]')).toHaveLength(4);
    expect(rendered.animation.animate).toHaveBeenCalledTimes(4);
    expect(rendered.animation.animate.mock.calls[0][2]).toMatchObject({ easing: 'linear' });
    expect(svg.querySelector('.agent-event-bus__route-head')?.getAttribute('d')).toMatch(
      /^M 40 .* H 40$/,
    );
    expect(svg.querySelectorAll('circle')[0]).toHaveAttribute('cx', '40');
    expect(svg.querySelectorAll('circle')[0]).toHaveAttribute('r', '1.75');
    // The bloom is a round point light, so the gutter boundary is a gradient mask
    // rather than a hard clip — a clip would slice the disc into a visible half-moon.
    const glowMask = svg.querySelector('mask');
    const maskRect = glowMask?.querySelector('rect');
    const fadeGradient = svg.querySelector('linearGradient');
    const clippedLayer = screen.getByTestId('agent-event-bus-clipped-glow-layer');
    const tail = svg.querySelector('.agent-event-bus__route-tail');
    const body = svg.querySelector('.agent-event-bus__route-body');
    const head = svg.querySelector('.agent-event-bus__route-head');
    const ignition = svg.querySelector('[data-marker-kind="ignition"]');
    // The overlay reaches 16px left of the panel so the bloom can spill into the page
    // gutter; the viewBox origin and the mask region must both follow it, or the bloom is
    // clipped straight back to the panel edge.
    expect(svg).toHaveAttribute('viewBox', '-16 0 336 400');
    expect(glowMask).toHaveAttribute('maskUnits', 'userSpaceOnUse');
    expect(maskRect).toHaveAttribute('x', '-16');
    expect(maskRect).toHaveAttribute('width', '336');
    expect(maskRect).toHaveAttribute('height', '400');
    expect(maskRect).toHaveAttribute('fill', `url(#${fadeGradient?.id})`);
    // Full strength across the gutter, gone by the fade boundary.
    expect(fadeGradient).toHaveAttribute('gradientUnits', 'userSpaceOnUse');
    expect(fadeGradient).toHaveAttribute('x1', '16');
    expect(fadeGradient).toHaveAttribute('x2', '40');
    expect(clippedLayer).toHaveAttribute('mask', `url(#${glowMask?.id})`);
    expect(clippedLayer).toContainElement(tail);
    expect(clippedLayer).not.toContainElement(body);
    expect(clippedLayer).not.toContainElement(head);
    expect(clippedLayer).not.toContainElement(ignition);
    const tailFilterId = tail?.getAttribute('filter')?.slice(5, -1) ?? '';
    const bloomFilter = svg.querySelector(`filter[id="${tailFilterId}"]`);
    expect(tailFilterId).toMatch(/^agent-event-bus-glow-bloom-/);
    // Blur ONLY. Merging SourceGraphic back over the blur paints the sharp dash on top
    // of its own halo, which renders a hard-edged disc rather than soft light.
    expect(bloomFilter?.querySelector('feGaussianBlur')).not.toBeNull();
    expect(bloomFilter?.querySelector('feMerge')).toBeNull();
    expect(body).not.toHaveAttribute('filter');
    expect(head).not.toHaveAttribute('filter');
    expect(ignition).not.toHaveAttribute('filter');
    expect(head?.parentElement).toHaveAttribute('data-event-kind', 'agent-message');
    expect(head?.parentElement).toHaveClass('agent-event-bus__route--agent-message');
    const firstFlightHandles = rendered.animation.animate.mock.calls.flatMap(([element], index) =>
      (element as SVGElement).dataset.animationKind === 'flight'
        ? [rendered.animation.handles[index]]
        : [],
    );
    const ignitionCallIndex = rendered.animation.animate.mock.calls.findIndex(
      ([element]) => (element as SVGElement).dataset.animationKind === 'ignition',
    );
    const ignitionHandle = rendered.animation.handles[ignitionCallIndex];

    rendered.rerender(
      <BusHarness
        projectId="project-1"
        recipientTop={180}
        layoutEnvironment={rendered.layout.environment}
        schedulerEnvironment={rendered.scheduler.environment}
        animationDriver={rendered.animation.driver}
      />,
    );
    rendered.layout.flushAll();

    expect(firstFlightHandles.every((handle) => handle.cancel.mock.calls.length > 0)).toBe(true);
    expect(ignitionHandle.cancel).not.toHaveBeenCalled();
    expect(svg.querySelector('[data-marker-kind="ignition"]')).toBe(ignition);
    expect(rendered.animation.animate).toHaveBeenCalledTimes(7);
    expect(
      rendered.animation.animate.mock.calls.filter(([element]) => element === ignition),
    ).toHaveLength(1);

    rendered.rerender(
      <BusHarness
        projectId="project-1"
        showRecipient={false}
        layoutEnvironment={rendered.layout.environment}
        schedulerEnvironment={rendered.scheduler.environment}
        animationDriver={rendered.animation.driver}
      />,
    );
    rendered.layout.flushAll();

    expect(svg.querySelectorAll('[data-route-animation]')).toHaveLength(0);
    expect(svg.querySelectorAll('.agent-event-bus__idle-anchor')).toHaveLength(1);
    expect(ignitionHandle.cancel).toHaveBeenCalledTimes(1);
  });

  it('requests role-specific flight keyframes and starts later messages independently', () => {
    const rendered = renderBus();
    const svg = screen.getByTestId('agent-event-bus-svg');

    act(() => mockStreamHandler?.(directFrame()));

    const layers = [...svg.querySelectorAll<SVGPathElement>('[data-pulse-role]')];
    expect(layers.map(({ dataset }) => dataset.pulseRole)).toEqual(['tail', 'body', 'head']);
    // All three layers ride one shared dash geometry so they stay perfectly concentric —
    // the point light's falloff is stroke width, not segment length. Distinct dash
    // lengths here would stretch the pulse back into a capsule.
    expect(new Set(layers.map((element) => element.getAttribute('stroke-dasharray'))).size).toBe(1);
    expect(new Set(layers.map((element) => element.getAttribute('stroke-dashoffset'))).size).toBe(
      1,
    );
    for (const layer of layers) {
      const call = rendered.animation.animate.mock.calls.find(([element]) => element === layer);
      const keyframes = call?.[1] as Keyframe[];
      expect(keyframes[0]).toMatchObject({ offset: 0 });
      expect(Number(keyframes[0].strokeDashoffset)).toBeGreaterThan(
        Number(layer.dataset.routeLength),
      );
      expect(keyframes.at(-1)).toMatchObject({ offset: 1 });
      expect(call?.[2]).toEqual({
        duration: EVENT_BUS_ROUTE_DURATION_MS,
        easing: 'linear',
        fill: 'forwards',
      });
      expect(layer.dataset.routeAnimation).toMatch(
        new RegExp(`^1:route:1:1:${layer.dataset.pulseRole}$`),
      );
    }
    expect(svg.querySelector('[data-marker-kind="ignition"]')?.dataset.routeAnimation).toBe(
      '1:route:1:ignition',
    );

    act(() => mockStreamHandler?.(directFrame()));

    const flightAnimationKeys = [...svg.querySelectorAll<SVGPathElement>('[data-pulse-role]')].map(
      (element) => element.dataset.routeAnimation,
    );
    expect(flightAnimationKeys).toHaveLength(6);
    expect(new Set(flightAnimationKeys).size).toBe(6);
    expect(rendered.animation.animate).toHaveBeenCalledTimes(8);
  });

  it.each(['delivered', 'failed'] as const)(
    'shows %s recipient feedback only at arrival and removes it after the endpoint window',
    (status) => {
      const rendered = renderBus();
      const svg = screen.getByTestId('agent-event-bus-svg');
      act(() => mockStreamHandler?.(directFrame(status)));
      const [sourceAnchor, recipientAnchor] = [
        ...svg.querySelectorAll('.agent-event-bus__idle-anchor'),
      ];

      expect(sourceAnchor).not.toHaveClass('agent-event-bus__active-anchor');
      expect(recipientAnchor).not.toHaveClass('agent-event-bus__active-anchor');
      expect(recipientAnchor).not.toHaveClass('agent-event-bus__failed-anchor');
      expect(svg.querySelector('.agent-event-bus__route--failed')).not.toBeInTheDocument();

      rendered.scheduler.runDelay(EVENT_BUS_ROUTE_DURATION_MS);

      expect(sourceAnchor).not.toHaveClass('agent-event-bus__active-anchor');
      expect(recipientAnchor).toHaveClass('agent-event-bus__active-anchor');
      expect(recipientAnchor).toHaveClass(
        status === 'failed' ? 'agent-event-bus__failed-anchor' : 'agent-event-bus__active-anchor',
      );
      if (status === 'delivered') {
        expect(recipientAnchor).not.toHaveClass('agent-event-bus__failed-anchor');
      }
      const arrival = svg.querySelector('[data-marker-kind="arrival"]');
      expect(arrival).toHaveClass(
        status === 'failed'
          ? 'agent-event-bus__feedback--failed'
          : 'agent-event-bus__feedback--agent-message',
      );
      expect(svg.querySelectorAll('[data-route-animation]')).toHaveLength(4);

      rendered.scheduler.runDelay(240);

      expect(recipientAnchor).not.toHaveClass('agent-event-bus__active-anchor');
      expect(recipientAnchor).not.toHaveClass('agent-event-bus__failed-anchor');
      expect(svg.querySelectorAll('[data-route-animation]')).toHaveLength(0);
    },
  );

  it('retains one arrival marker while geometry generations restart the three flight roles', () => {
    const rendered = renderBus();
    const svg = screen.getByTestId('agent-event-bus-svg');
    act(() => mockStreamHandler?.(directFrame()));
    rendered.scheduler.runDelay(EVENT_BUS_ROUTE_DURATION_MS);

    const arrival = svg.querySelector('[data-marker-kind="arrival"]');
    const arrivalCallIndex = rendered.animation.animate.mock.calls.findIndex(
      ([element]) => element === arrival,
    );
    const arrivalHandle = rendered.animation.handles[arrivalCallIndex];
    expect(arrival).not.toBeNull();
    expect(rendered.animation.animate).toHaveBeenCalledTimes(5);

    rendered.rerender(
      <BusHarness
        projectId="project-1"
        recipientTop={180}
        layoutEnvironment={rendered.layout.environment}
        schedulerEnvironment={rendered.scheduler.environment}
        animationDriver={rendered.animation.driver}
      />,
    );
    rendered.layout.flushAll();

    expect(svg.querySelector('[data-marker-kind="arrival"]')).toBe(arrival);
    expect(arrivalHandle.cancel).not.toHaveBeenCalled();
    expect(rendered.animation.animate).toHaveBeenCalledTimes(8);
    expect(
      rendered.animation.animate.mock.calls.filter(([element]) => element === arrival),
    ).toHaveLength(1);
    expect(
      [...svg.querySelectorAll('[data-pulse-role]')].map(
        (element) => (element as SVGElement).dataset.routeAnimation,
      ),
    ).toEqual([
      expect.stringMatching(/:2:tail$/),
      expect.stringMatching(/:2:body$/),
      expect.stringMatching(/:2:head$/),
    ]);
  });

  it('opens the focusable context lane by keyboard and synchronously switches to static flashes', async () => {
    window.localStorage.setItem(EVENT_BUS_REDUCE_MOTION_STORAGE_KEY, '{malformed');
    const matchMedia = jest.fn();
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: matchMedia });
    const rendered = renderBus();
    act(() => mockStreamHandler?.(directFrame('failed')));
    const animatedHandles = [...rendered.animation.handles];
    const lane = screen.getByTestId('agent-event-bus-control-lane');

    fireEvent.keyDown(lane, { key: 'F10', code: 'F10', shiftKey: true });
    const checkbox = await screen.findByRole('menuitemcheckbox', { name: 'Reduce motion' });
    expect(checkbox).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(checkbox);

    expect(animatedHandles.every((handle) => handle.cancel.mock.calls.length > 0)).toBe(true);
    expect(
      screen.getByTestId('agent-event-bus-svg').querySelectorAll('[data-route-animation]'),
    ).toHaveLength(0);
    expect(window.localStorage.getItem(EVENT_BUS_REDUCE_MOTION_STORAGE_KEY)).toBe('true');
    expect(readAgentEventBusReduceMotion()).toBe(true);
    expect(matchMedia).not.toHaveBeenCalled();

    fireEvent.contextMenu(lane);
    const checkedCheckbox = await screen.findByRole('menuitemcheckbox', {
      name: 'Reduce motion',
    });
    expect(checkedCheckbox).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(checkedCheckbox);
    expect(window.localStorage.getItem(EVENT_BUS_REDUCE_MOTION_STORAGE_KEY)).toBe('false');

    act(() => mockStreamHandler?.(directFrame()));
    await waitFor(() => expect(rendered.animation.animate).toHaveBeenCalledTimes(8));
  });

  it('routes an epic handover between agents and a first assignment from the origin', () => {
    renderBus();
    const svg = screen.getByTestId('agent-event-bus-svg');

    // Re-assignment: previous holder -> new holder, so it travels agent to agent.
    act(() =>
      mockStreamHandler?.({ kind: 'epic-assigned', fromAgentId: 'sender', toAgentId: 'recipient' }),
    );

    const handover = svg.querySelector('[data-event-kind="epic-assigned"]');
    expect(handover).not.toBeNull();
    expect(handover?.closest('[data-route-source]')).toHaveAttribute('data-route-source', 'agent');

    // First assignment has no previous holder, so it rides the runtime origin instead.
    act(() =>
      mockStreamHandler?.({ kind: 'epic-assigned', fromAgentId: null, toAgentId: 'recipient' }),
    );

    expect(
      svg.querySelectorAll('[data-event-kind="epic-assigned"][data-route-source="runtime"]').length,
    ).toBeGreaterThan(0);

    // Domain silhouette: epics are a diamond, and it must be an OUTLINE so the spark core
    // stays visible inside it rather than being punched through.
    const marker = svg.querySelector('[data-marker-kind="ignition"] .agent-event-bus__marker-ring');
    expect(marker?.tagName).toBe('rect');
    expect(marker).toHaveClass('agent-event-bus__marker-ring--outline');
  });

  it('keeps one domain identity across a pulse lifecycle instead of deriving it from topology', () => {
    renderBus();
    const svg = screen.getByTestId('agent-event-bus-svg');
    const ignitionFor = (source: 'agent' | 'runtime') =>
      svg.querySelector(`[data-marker-kind="ignition"][data-route-source="${source}"]`);

    // Agent-sourced handover: the ignition must not fall back to the message identity
    // just because the route happens to start at an agent row.
    act(() =>
      mockStreamHandler?.({ kind: 'epic-assigned', fromAgentId: 'sender', toAgentId: 'recipient' }),
    );
    expect(ignitionFor('agent')).toHaveClass('agent-event-bus__feedback--epic-assigned');
    expect(ignitionFor('agent')).not.toHaveClass('agent-event-bus__feedback--agent-message');

    // Runtime-sourced first assignment: likewise must not read as a session start.
    act(() =>
      mockStreamHandler?.({ kind: 'epic-assigned', fromAgentId: null, toAgentId: 'recipient' }),
    );
    expect(ignitionFor('runtime')).toHaveClass('agent-event-bus__feedback--epic-assigned');
    expect(ignitionFor('runtime')).not.toHaveClass('agent-event-bus__feedback--session-started');
  });

  it('still identifies a real session start as a session start', () => {
    // Fresh bus: runtime routes stagger by ordinal, so a third frame would still be
    // pending behind its timer rather than rendered.
    renderBus();
    const svg = screen.getByTestId('agent-event-bus-svg');

    act(() => mockStreamHandler?.({ kind: 'session-started', agentId: 'recipient' }));

    const ignition = svg.querySelector(
      '[data-marker-kind="ignition"][data-route-source="runtime"]',
    );
    expect(ignition).toHaveClass('agent-event-bus__feedback--session-started');
    expect(ignition).not.toHaveClass('agent-event-bus__feedback--epic-assigned');
  });

  it('colors the static runtime origin by the epic identity under Reduce Motion', () => {
    window.localStorage.setItem(EVENT_BUS_REDUCE_MOTION_STORAGE_KEY, 'true');
    renderBus();

    act(() =>
      mockStreamHandler?.({ kind: 'epic-assigned', fromAgentId: null, toAgentId: 'recipient' }),
    );

    // Reduce Motion renders the origin statically; it previously hard-coded the session
    // class, so an epic first-assignment lit the origin amber.
    const origin = screen.getByTestId('agent-event-bus-runtime-origin');
    expect(origin).toHaveClass('agent-event-bus__feedback--epic-assigned');
    expect(origin).not.toHaveClass('agent-event-bus__feedback--session-started');
  });

  it('renders runtime startup from the top origin and neutral target feedback alongside messages', () => {
    const rendered = renderBus();
    const svg = screen.getByTestId('agent-event-bus-svg');

    act(() => {
      mockStreamHandler?.({ kind: 'session-started', agentId: 'recipient' });
      mockStreamHandler?.(directFrame());
    });

    expect(svg.querySelector('.agent-event-bus__idle-conductor')).toHaveAttribute(
      'd',
      expect.stringMatching(/^M 4 8 V /),
    );
    const clippedLayer = screen.getByTestId('agent-event-bus-clipped-glow-layer');
    const runtimeIgnition = svg.querySelector(
      '[data-marker-kind="ignition"][data-route-source="runtime"]',
    );
    const runtimeRing = runtimeIgnition?.querySelector('.agent-event-bus__marker-ring');
    const agentIgnition = svg.querySelector(
      '[data-marker-kind="ignition"][data-route-source="agent"]',
    );
    expect(runtimeRing).toHaveAttribute('cx', '4');
    expect(runtimeRing).toHaveAttribute('cy', '8');
    expect(clippedLayer).toContainElement(runtimeIgnition);
    expect(runtimeIgnition).toHaveAttribute(
      'filter',
      expect.stringMatching(/^url\(#agent-event-bus-glow-/),
    );
    expect(clippedLayer).not.toContainElement(agentIgnition);
    expect(agentIgnition).not.toHaveAttribute('filter');
    expect(
      svg.querySelectorAll('[data-route-source="runtime"] [data-route-animation]'),
    ).toHaveLength(3);
    expect(svg.querySelectorAll('[data-route-source="agent"] [data-route-animation]')).toHaveLength(
      3,
    );
    expect(
      svg
        .querySelector('[data-route-source="runtime"] .agent-event-bus__route-head')
        ?.getAttribute('d'),
    ).toMatch(/^M 4 8 V .* H 40$/);
    expect(
      svg.querySelector('[data-route-source="runtime"] .agent-event-bus__route-head')
        ?.parentElement,
    ).toHaveClass('agent-event-bus__route--session-started');

    rendered.scheduler.runDelay(EVENT_BUS_ROUTE_DURATION_MS);

    expect(runtimeIgnition).not.toBeInTheDocument();
    expect(svg.querySelectorAll('[data-marker-kind="arrival"]')).toHaveLength(2);
    const recipientAnchor = [...svg.querySelectorAll('.agent-event-bus__idle-anchor')][1];
    expect(recipientAnchor).toHaveClass('agent-event-bus__active-anchor');
    expect(recipientAnchor).not.toHaveClass('agent-event-bus__failed-anchor');
  });

  it('shows synchronous static runtime origin and target feedback under Reduce motion', () => {
    window.localStorage.setItem(EVENT_BUS_REDUCE_MOTION_STORAGE_KEY, 'true');
    const rendered = renderBus();
    const svg = screen.getByTestId('agent-event-bus-svg');

    act(() => mockStreamHandler?.({ kind: 'session-started', agentId: 'recipient' }));

    expect(svg.querySelectorAll('[data-route-animation]')).toHaveLength(0);
    expect(screen.getByTestId('agent-event-bus-runtime-origin')).toBeInTheDocument();
    const recipientAnchor = [...svg.querySelectorAll('.agent-event-bus__idle-anchor')][1];
    expect(recipientAnchor).toHaveClass('agent-event-bus__active-anchor');
    expect(recipientAnchor).not.toHaveClass('agent-event-bus__failed-anchor');

    rendered.scheduler.runDelay(280);

    expect(screen.queryByTestId('agent-event-bus-runtime-origin')).not.toBeInTheDocument();
    expect(recipientAnchor).not.toHaveClass('agent-event-bus__active-anchor');
  });

  it.each([
    ['startup then failure', ['startup', 'failure']],
    ['failure then startup', ['failure', 'startup']],
  ] as const)('ranks failed delivery above session feedback for %s', (_caseName, order) => {
    window.localStorage.setItem(EVENT_BUS_REDUCE_MOTION_STORAGE_KEY, 'true');
    renderBus();

    act(() => {
      for (const event of order) {
        if (event === 'startup') {
          mockStreamHandler?.({ kind: 'session-started', agentId: 'recipient' });
        } else {
          mockStreamHandler?.(directFrame('failed'));
        }
      }
    });

    const recipientAnchor = [
      ...screen
        .getByTestId('agent-event-bus-svg')
        .querySelectorAll('.agent-event-bus__idle-anchor'),
    ][1];
    expect(recipientAnchor).toHaveClass(
      'agent-event-bus__feedback--failed',
      'agent-event-bus__failed-anchor',
    );
  });

  it.each([
    ['startup then message', ['startup', 'message']],
    ['message then startup', ['message', 'startup']],
  ] as const)('ranks agent-message feedback above session feedback for %s', (_caseName, order) => {
    window.localStorage.setItem(EVENT_BUS_REDUCE_MOTION_STORAGE_KEY, 'true');
    renderBus();

    act(() => {
      for (const event of order) {
        mockStreamHandler?.(
          event === 'startup' ? { kind: 'session-started', agentId: 'recipient' } : directFrame(),
        );
      }
    });

    const recipientAnchor = [
      ...screen
        .getByTestId('agent-event-bus-svg')
        .querySelectorAll('.agent-event-bus__idle-anchor'),
    ][1];
    expect(recipientAnchor).toHaveClass('agent-event-bus__feedback--agent-message');
    expect(recipientAnchor).not.toHaveClass('agent-event-bus__feedback--session-started');
  });

  it('resets full old-scope capacity before accepting a frame that waits for fresh geometry', () => {
    const rendered = renderBus();
    for (let index = 0; index < 24; index += 1) {
      act(() => mockStreamHandler?.(directFrame()));
    }
    expect(
      screen.getByTestId('agent-event-bus-svg').querySelectorAll('[data-route-animation]'),
    ).toHaveLength(24);
    const oldAnimationHandles = [...rendered.animation.handles];
    const oldTimerCount = rendered.scheduler.timers.length;
    const oldLayoutCallbacks = rendered.layout.snapshotCallbacks();
    const oldTimerCallbacks = rendered.scheduler.snapshotCallbacks();

    mockSelectedSocket = {} as Socket;
    rendered.rerender(
      <BusHarness
        projectId="project-2"
        layoutEnvironment={rendered.layout.environment}
        schedulerEnvironment={rendered.scheduler.environment}
        animationDriver={rendered.animation.driver}
      />,
    );

    expect(oldAnimationHandles.every((handle) => handle.cancel.mock.calls.length > 0)).toBe(true);
    expect(rendered.scheduler.timers.slice(0, oldTimerCount).every((timer) => timer.cleared)).toBe(
      true,
    );

    act(() => mockStreamHandler?.(directFrame()));
    expect(
      screen.getByTestId('agent-event-bus-svg').querySelectorAll('[data-route-animation]'),
    ).toHaveLength(0);

    rendered.layout.forceCallbacks(oldLayoutCallbacks);
    rendered.scheduler.forceCallbacks(oldTimerCallbacks);
    expect(
      screen.getByTestId('agent-event-bus-svg').querySelectorAll('[data-route-animation]'),
    ).toHaveLength(0);

    rendered.layout.flushAll();
    expect(
      screen.getByTestId('agent-event-bus-svg').querySelectorAll('[data-route-animation]'),
    ).toHaveLength(4);
    rendered.scheduler.forceCallbacks(oldTimerCallbacks);
    expect(
      screen.getByTestId('agent-event-bus-svg').querySelectorAll('.agent-event-bus__failed-anchor'),
    ).toHaveLength(0);
  });

  it('cleans up observers, animations, timers, and pending layout work on unmount', () => {
    const rendered = renderBus();
    act(() => mockStreamHandler?.(directFrame()));
    const handles = [...rendered.animation.handles];

    rendered.unmount();

    expect(handles.every((handle) => handle.cancel.mock.calls.length > 0)).toBe(true);
    expect(rendered.scheduler.timers.every((timer) => timer.cleared)).toBe(true);
    expect(rendered.layout.observers.every((observer) => observer.disconnected)).toBe(true);
  });
});
