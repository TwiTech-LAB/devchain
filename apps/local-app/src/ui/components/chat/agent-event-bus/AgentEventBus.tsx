import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefCallback,
  type RefObject,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { Socket } from 'socket.io-client';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@/ui/components/ui/context-menu';
import { browserAgentEventBusAnimationDriver } from './animation-driver';
import {
  DEFAULT_BUS_X,
  EVENT_BUS_GLOW_FADE_RIGHT,
  EVENT_BUS_GUTTER_LEFT_BLEED,
  EVENT_BUS_GUTTER_RIGHT,
} from './geometry';
import { readAgentEventBusReduceMotion, writeAgentEventBusReduceMotion } from './preference';
import {
  AGENT_EVENT_BUS_ARRIVAL_KEYFRAMES,
  AGENT_EVENT_BUS_ARRIVAL_OPTIONS,
  AGENT_EVENT_BUS_IGNITION_KEYFRAMES,
  AGENT_EVENT_BUS_IGNITION_OPTIONS,
  createAgentEventBusPulseChoreography,
  isAgentEventBusPulseRole,
} from './pulse-choreography';
import { AgentEventBusScheduler, type AgentEventBusSchedulerEnvironment } from './scheduler';
import {
  useAgentEventBusLayout,
  type AgentEventBusLayoutEnvironment,
} from './useAgentEventBusLayout';
import { useAgentEventBusStream, type AgentEventBusStreamFrame } from './useAgentEventBusStream';
import type {
  AgentEventBusActiveRoute,
  AgentEventBusEventKind,
  AgentEventBusAnchorDescriptor,
  AgentEventBusAnimationDriver,
  AgentEventBusAnimationHandle,
  AgentEventBusLayoutApi,
} from './types';
import './agent-event-bus.css';

const AgentEventBusLayoutContext = createContext<AgentEventBusLayoutApi | null>(null);
const NOOP_ANCHOR_REF: RefCallback<HTMLElement> = () => undefined;
/** Slack around the overlay so the bloom's blur is never cut off at the viewBox edge. */
const BLOOM_FILTER_MARGIN = 64;

export interface AgentEventBusProps {
  projectId: string | null | undefined;
  containerRef: RefObject<HTMLElement>;
  children?: ReactNode;
  animationDriver?: AgentEventBusAnimationDriver;
  layoutEnvironment?: AgentEventBusLayoutEnvironment;
  schedulerEnvironment?: AgentEventBusSchedulerEnvironment;
  busX?: number;
}

function idleBranchPath(busX: number, anchorX: number, anchorY: number): string {
  const cornerRadius = Math.min(7, Math.max(0, Math.abs(anchorX - busX) / 2));
  const direction = Math.sign(anchorX - busX) || 1;
  const cornerX = busX + direction * cornerRadius;
  return `M ${busX} ${anchorY - cornerRadius} Q ${busX} ${anchorY} ${cornerX} ${anchorY} H ${anchorX}`;
}

function activeBranchPath(busX: number, anchorX: number, anchorY: number): string {
  return `M ${busX} ${anchorY} H ${anchorX}`;
}

type AgentEventBusFeedbackKind = AgentEventBusEventKind | 'failed';
type AgentEventBusMarkerShape = 'disc' | 'ring' | 'diamond';

const AGENT_EVENT_BUS_FEEDBACK_RANK: Record<AgentEventBusFeedbackKind, number> = {
  'session-started': 1,
  'epic-assigned': 2,
  'agent-message': 3,
  failed: 4,
};

/**
 * Domain silhouettes. Only shapes that ENCLOSE the spark core qualify — an open shape
 * (chevron, bars) is punched through by the core and reads as a smudge at this size.
 * Three is the practical ceiling: at ~13px a fourth outline stops being distinguishable.
 */
const AGENT_EVENT_BUS_SILHOUETTE: Record<AgentEventBusEventKind, AgentEventBusMarkerShape> = {
  'agent-message': 'disc',
  'session-started': 'ring',
  'epic-assigned': 'diamond',
};

function routeFeedbackKind(route: AgentEventBusActiveRoute): AgentEventBusFeedbackKind {
  if (route.feedback.kind === 'delivery' && route.feedback.status === 'failed') return 'failed';
  // Identity comes from what the event IS, not from where its route happens to start —
  // an epic can be handed over by an agent or assigned by the system.
  return route.eventKind;
}

function mergeAnchorFeedback(
  activity: Map<string, AgentEventBusFeedbackKind>,
  anchorKey: string,
  feedback: AgentEventBusFeedbackKind,
): void {
  const current = activity.get(anchorKey);
  if (
    !current ||
    AGENT_EVENT_BUS_FEEDBACK_RANK[feedback] > AGENT_EVENT_BUS_FEEDBACK_RANK[current]
  ) {
    activity.set(anchorKey, feedback);
  }
}

function feedbackClassName(feedback: AgentEventBusFeedbackKind): string {
  return `agent-event-bus__feedback--${feedback}`;
}

interface MarkerSilhouetteProps {
  shape: AgentEventBusMarkerShape;
  x: number;
  y: number;
}

function MarkerSilhouette({ shape, x, y }: MarkerSilhouetteProps): ReactElement {
  if (shape === 'diamond') {
    return (
      <rect
        className="agent-event-bus__marker-ring agent-event-bus__marker-ring--outline"
        x={x - 2.9}
        y={y - 2.9}
        width="5.8"
        height="5.8"
        transform={`rotate(45 ${x} ${y})`}
      />
    );
  }
  return (
    <circle
      className={`agent-event-bus__marker-ring${shape === 'ring' ? ' agent-event-bus__marker-ring--outline' : ''}`}
      cx={x}
      cy={y}
      r="3.25"
    />
  );
}

interface PulseMarkerProps {
  route: AgentEventBusActiveRoute;
  kind: 'ignition' | 'arrival';
  x: number;
  y: number;
  filter?: string;
}

function PulseMarker({ route, kind, x, y, filter }: PulseMarkerProps): ReactElement {
  const feedback = kind === 'ignition' ? route.eventKind : routeFeedbackKind(route);

  return (
    <g key={route.id} data-route-parent={route.id} data-marker-parent={kind}>
      <g
        className={`agent-event-bus__marker agent-event-bus__marker--${kind} ${feedbackClassName(feedback)}`}
        filter={filter}
        data-route-animation={`${route.id}:${kind}`}
        data-animation-kind={kind}
        data-marker-kind={kind}
        data-route-source={route.source.kind}
      >
        {/* Same material as the travelling pulse — graduated halo around a spark core —
            so ignition and arrival read as the same light rather than a separate ripple.
            Built from concentric fills, not a blur, because agent-side markers sit over
            the cards where filtered bloom is not allowed. */}
        <circle className="agent-event-bus__marker-bloom" cx={x} cy={y} r="5" />
        <MarkerSilhouette shape={AGENT_EVENT_BUS_SILHOUETTE[route.eventKind]} x={x} y={y} />
        <circle className="agent-event-bus__marker-core" cx={x} cy={y} r="1.25" />
      </g>
    </g>
  );
}

export function useAgentEventBusAnchor(
  descriptor: AgentEventBusAnchorDescriptor | null | undefined,
): RefCallback<HTMLElement> {
  const layout = useContext(AgentEventBusLayoutContext);
  const anchorRef = useMemo(
    () => (descriptor ? (layout?.getAnchorRef(descriptor) ?? NOOP_ANCHOR_REF) : NOOP_ANCHOR_REF),
    [descriptor?.agentId, descriptor?.key, descriptor?.teamId, layout],
  );
  useLayoutEffect(() => {
    layout?.refreshRegistrationOrder();
  });
  return anchorRef;
}

export function AgentEventBus({
  projectId,
  containerRef,
  children,
  animationDriver = browserAgentEventBusAnimationDriver,
  layoutEnvironment,
  schedulerEnvironment,
  busX = DEFAULT_BUS_X,
}: AgentEventBusProps): ReactElement {
  const [activeRoutes, setActiveRoutes] = useState<AgentEventBusActiveRoute[]>([]);
  const [scopeEpoch, setScopeEpoch] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(readAgentEventBusReduceMotion);
  const schedulerRef = useRef<AgentEventBusScheduler>();
  if (!schedulerRef.current) {
    schedulerRef.current = new AgentEventBusScheduler(setActiveRoutes, schedulerEnvironment);
  }
  const scheduler = schedulerRef.current;
  const animationHandlesRef = useRef(new Map<string, AgentEventBusAnimationHandle>());
  const svgRef = useRef<SVGSVGElement>(null);
  const svgId = useId().replace(/:/g, '');
  const filterId = `agent-event-bus-glow-${svgId}`;
  const bloomFilterId = `agent-event-bus-glow-bloom-${svgId}`;
  const glowMaskId = `agent-event-bus-glow-mask-${svgId}`;
  const glowFadeGradientId = `agent-event-bus-glow-fade-${svgId}`;

  const cancelAnimatedHandles = useCallback(() => {
    for (const handle of animationHandlesRef.current.values()) handle.cancel();
    animationHandlesRef.current.clear();
  }, []);

  const handleFrame = useCallback(
    (frame: AgentEventBusStreamFrame) => {
      scheduler.enqueue(frame);
    },
    [scheduler],
  );
  const socket: Socket = useAgentEventBusStream(projectId, handleFrame);
  const layout = useAgentEventBusLayout({
    containerRef,
    scopeEpoch,
    busX,
    ...(layoutEnvironment ? { environment: layoutEnvironment } : {}),
  });
  const layoutContextValue = useMemo<AgentEventBusLayoutApi>(
    () => ({
      getAnchorRef: layout.getAnchorRef,
      refreshRegistrationOrder: layout.refreshRegistrationOrder,
    }),
    [layout.getAnchorRef, layout.refreshRegistrationOrder],
  );

  useLayoutEffect(() => {
    cancelAnimatedHandles();
    const nextScopeEpoch = scheduler.resetScope(projectId, socket);
    setScopeEpoch(nextScopeEpoch);
  }, [cancelAnimatedHandles, projectId, scheduler, socket]);

  useLayoutEffect(() => {
    scheduler.setReduceMotion(reduceMotion);
  }, [reduceMotion, scheduler]);

  useLayoutEffect(() => {
    if (layout.geometry) scheduler.commitGeometry(layout.geometry);
  }, [layout.geometry, scheduler]);

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const wantedHandles = new Set<string>();
    const animatedElements = svg.querySelectorAll<SVGElement>('[data-route-animation]');
    animatedElements.forEach((element) => {
      const animationKey = element.dataset.routeAnimation;
      const animationKind = element.dataset.animationKind;
      if (!animationKey || !animationKind) return;

      let keyframes: Keyframe[];
      let options: KeyframeAnimationOptions;
      if (animationKind === 'flight') {
        const pulseRole = element.dataset.pulseRole;
        const routeLength = Number(element.dataset.routeLength);
        const routeDuration = Number(element.dataset.routeDuration);
        if (
          !isAgentEventBusPulseRole(pulseRole) ||
          !Number.isFinite(routeLength) ||
          !Number.isFinite(routeDuration)
        ) {
          return;
        }
        const descriptor = createAgentEventBusPulseChoreography(routeLength, routeDuration).find(
          ({ role }) => role === pulseRole,
        );
        if (!descriptor) return;
        keyframes = descriptor.keyframes;
        options = descriptor.options;
      } else if (animationKind === 'ignition') {
        keyframes = AGENT_EVENT_BUS_IGNITION_KEYFRAMES;
        options = AGENT_EVENT_BUS_IGNITION_OPTIONS;
      } else if (animationKind === 'arrival') {
        keyframes = AGENT_EVENT_BUS_ARRIVAL_KEYFRAMES;
        options = AGENT_EVENT_BUS_ARRIVAL_OPTIONS;
      } else {
        return;
      }

      wantedHandles.add(animationKey);
      if (animationHandlesRef.current.has(animationKey)) return;
      const handle = animationDriver.animate(element, keyframes, options);
      animationHandlesRef.current.set(animationKey, handle);
    });

    for (const [key, handle] of animationHandlesRef.current) {
      if (wantedHandles.has(key)) continue;
      handle.cancel();
      animationHandlesRef.current.delete(key);
    }
  }, [activeRoutes, animationDriver]);

  useLayoutEffect(() => {
    return () => cancelAnimatedHandles();
  }, [animationDriver, cancelAnimatedHandles]);

  useLayoutEffect(() => {
    return () => scheduler.dispose();
  }, [scheduler]);

  const handleReduceMotionChange = useCallback(
    (checked: boolean | 'indeterminate') => {
      const enabled = checked === true;
      cancelAnimatedHandles();
      scheduler.setReduceMotion(enabled);
      setReduceMotion(enabled);
      writeAgentEventBusReduceMotion(enabled);
    },
    [cancelAnimatedHandles, scheduler],
  );
  const handleControlLaneKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + Math.min(rect.height / 2, 24),
      }),
    );
  }, []);

  const geometry = layout.geometry;
  const anchorActivity = useMemo(() => {
    const activity = new Map<string, AgentEventBusFeedbackKind>();
    for (const route of activeRoutes) {
      const feedback = routeFeedbackKind(route);
      if (
        route.source.kind === 'agent' &&
        route.mode === 'static' &&
        route.path.source.kind === 'agent'
      ) {
        mergeAnchorFeedback(activity, route.path.source.key, feedback);
      }
      if (route.mode === 'arrived' || route.mode === 'static') {
        mergeAnchorFeedback(activity, route.path.recipient.key, feedback);
      }
    }
    return activity;
  }, [activeRoutes]);
  // The origin can host simultaneous static routes of different kinds, so it takes the
  // highest-ranked identity rather than assuming every runtime route is a session start.
  const runtimeOriginFeedback = useMemo<AgentEventBusEventKind | null>(() => {
    let winner: AgentEventBusEventKind | null = null;
    for (const route of activeRoutes) {
      if (route.source.kind !== 'runtime' || route.mode !== 'static') continue;
      if (
        !winner ||
        AGENT_EVENT_BUS_FEEDBACK_RANK[route.eventKind] > AGENT_EVENT_BUS_FEEDBACK_RANK[winner]
      ) {
        winner = route.eventKind;
      }
    }
    return winner;
  }, [activeRoutes]);
  const conductorBounds = useMemo(() => {
    if (!geometry || geometry.anchors.length === 0) return null;
    const minimumY = geometry.runtimeOrigin.y;
    let maximumY = geometry.anchors[0].y;
    for (const anchor of geometry.anchors) {
      maximumY = Math.max(maximumY, anchor.y);
    }
    if (geometry.anchors.length === 1) {
      maximumY = Math.min(geometry.height, maximumY + 12);
    }
    return { minimumY, maximumY };
  }, [geometry]);
  const flightRoutes = useMemo(
    () =>
      activeRoutes
        .filter((route) => route.mode === 'traveling' || route.mode === 'arrived')
        .map((route) => {
          const eventKind = route.eventKind;
          return {
            route,
            routeKey: `${route.id}:${route.generation}`,
            layers: createAgentEventBusPulseChoreography(route.path.length, route.path.durationMs),
            eventKind,
            className: ['agent-event-bus__route', `agent-event-bus__route--${eventKind}`]
              .filter(Boolean)
              .join(' '),
          };
        }),
    [activeRoutes],
  );
  const ignitionRoutes = useMemo(
    () => activeRoutes.filter((route) => route.mode === 'traveling'),
    [activeRoutes],
  );
  const arrivedRoutes = useMemo(
    () => activeRoutes.filter((route) => route.mode === 'arrived'),
    [activeRoutes],
  );

  return (
    <AgentEventBusLayoutContext.Provider value={layoutContextValue}>
      {children}
      <svg
        ref={svgRef}
        className="agent-event-bus__overlay"
        aria-hidden="true"
        focusable="false"
        pointerEvents="none"
        // Extend left of the panel so the bloom can spill into the page gutter. The viewBox
        // origin moves with it, so every coordinate below (busX, anchors, gutter) keeps its
        // existing meaning relative to the panel edge at x=0.
        style={{
          left: `-${EVENT_BUS_GUTTER_LEFT_BLEED}px`,
          width: `calc(100% + ${EVENT_BUS_GUTTER_LEFT_BLEED}px)`,
        }}
        viewBox={
          geometry && geometry.width > 0 && geometry.height > 0
            ? `${-EVENT_BUS_GUTTER_LEFT_BLEED} 0 ${geometry.width + EVENT_BUS_GUTTER_LEFT_BLEED} ${geometry.height}`
            : undefined
        }
        preserveAspectRatio="none"
        data-testid="agent-event-bus-svg"
      >
        <defs>
          <filter id={filterId} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          {/*
            Blur ONLY — deliberately no `feMerge` with SourceGraphic. Merging the sharp
            source back over the blur is what turned the travelling bloom into a
            hard-edged disc; without it the layer is pure soft light around the core.
            `userSpaceOnUse` keeps the region valid for axis-aligned routes, whose
            object bounding box can collapse to zero width.
          */}
          <filter
            id={bloomFilterId}
            filterUnits="userSpaceOnUse"
            x={-BLOOM_FILTER_MARGIN}
            y={-BLOOM_FILTER_MARGIN}
            width={(geometry?.width ?? 0) + BLOOM_FILTER_MARGIN * 2}
            height={(geometry?.height ?? 0) + BLOOM_FILTER_MARGIN * 2}
          >
            <feGaussianBlur stdDeviation="3.2" />
          </filter>
          {/*
            Soft gutter falloff. Full strength through the gutter, fading to nothing by
            `EVENT_BUS_GLOW_FADE_RIGHT`, so the round bloom never shows a cut edge over a
            card. `spreadMethod` defaults to pad, so x < gutter stays white (opaque) and
            x > fade stays black (hidden).
          */}
          <linearGradient
            id={glowFadeGradientId}
            gradientUnits="userSpaceOnUse"
            x1={EVENT_BUS_GUTTER_RIGHT}
            y1="0"
            x2={EVENT_BUS_GLOW_FADE_RIGHT}
            y2="0"
          >
            <stop offset="0" stopColor="#fff" />
            <stop offset="1" stopColor="#000" />
          </linearGradient>
          {/* Spans the left bleed too — anything outside a mask region is hidden, which
              would clip the bloom right back to the panel edge. */}
          <mask
            id={glowMaskId}
            maskUnits="userSpaceOnUse"
            x={-EVENT_BUS_GUTTER_LEFT_BLEED}
            y="0"
            width={(geometry?.width ?? 0) + EVENT_BUS_GUTTER_LEFT_BLEED}
            height={geometry?.height ?? 0}
          >
            <rect
              x={-EVENT_BUS_GUTTER_LEFT_BLEED}
              y="0"
              width={(geometry?.width ?? 0) + EVENT_BUS_GUTTER_LEFT_BLEED}
              height={geometry?.height ?? 0}
              fill={`url(#${glowFadeGradientId})`}
            />
          </mask>
        </defs>
        {geometry ? (
          <g
            className="agent-event-bus__clipped-glow-layer"
            mask={`url(#${glowMaskId})`}
            data-testid="agent-event-bus-clipped-glow-layer"
          >
            {runtimeOriginFeedback ? (
              <circle
                className={`agent-event-bus__runtime-origin-halo ${feedbackClassName(runtimeOriginFeedback)}`}
                cx={geometry.runtimeOrigin.x}
                cy={geometry.runtimeOrigin.y}
                r="5"
                filter={`url(#${filterId})`}
                data-testid="agent-event-bus-runtime-origin-halo"
              />
            ) : null}
            {flightRoutes.map(({ route, routeKey, layers, eventKind, className }) => {
              const tail = layers.find(({ role }) => role === 'tail');
              return tail ? (
                <g key={route.id} data-route-parent={route.id}>
                  <g
                    key={`${routeKey}:tail`}
                    className={className}
                    data-route-source={route.source.kind}
                    data-event-kind={eventKind}
                  >
                    <path
                      className="agent-event-bus__route-tail"
                      d={route.path.d}
                      pathLength={route.path.length}
                      strokeDasharray={tail.dashArray}
                      strokeDashoffset={tail.startOffset}
                      filter={`url(#${bloomFilterId})`}
                      data-route-animation={`${routeKey}:tail`}
                      data-animation-kind="flight"
                      data-pulse-role="tail"
                      data-route-length={route.path.length}
                      data-route-duration={route.path.durationMs}
                    />
                  </g>
                </g>
              ) : null;
            })}
            {ignitionRoutes
              .filter((route) => route.source.kind === 'runtime')
              .map((route) => (
                <PulseMarker
                  key={route.id}
                  route={route}
                  kind="ignition"
                  x={route.path.source.x}
                  y={route.path.source.y}
                  filter={`url(#${filterId})`}
                />
              ))}
          </g>
        ) : null}
        {geometry && conductorBounds ? (
          <g>
            <path
              className="agent-event-bus__idle-conductor"
              d={`M ${geometry.busX} ${conductorBounds.minimumY} V ${conductorBounds.maximumY}`}
            />
            {runtimeOriginFeedback ? (
              <circle
                className={`agent-event-bus__active-anchor agent-event-bus__runtime-origin ${feedbackClassName(runtimeOriginFeedback)}`}
                cx={geometry.runtimeOrigin.x}
                cy={geometry.runtimeOrigin.y}
                r="1.75"
                data-testid="agent-event-bus-runtime-origin"
              />
            ) : null}
            {geometry.anchors.map((anchor) => {
              const activity = anchorActivity.get(anchor.key);
              return (
                <g key={anchor.key}>
                  <path
                    className="agent-event-bus__idle-branch"
                    d={idleBranchPath(geometry.busX, anchor.x, anchor.y)}
                  />
                  {activity ? (
                    <path
                      className={`agent-event-bus__active-branch ${feedbackClassName(activity)}`}
                      d={activeBranchPath(geometry.busX, anchor.x, anchor.y)}
                    />
                  ) : null}
                  <circle
                    className={[
                      'agent-event-bus__idle-anchor',
                      activity ? 'agent-event-bus__active-anchor' : '',
                      activity ? feedbackClassName(activity) : '',
                      activity === 'failed' ? 'agent-event-bus__failed-anchor' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    cx={anchor.x}
                    cy={anchor.y}
                    r="1.75"
                  />
                </g>
              );
            })}
          </g>
        ) : null}
        <g className="agent-event-bus__connector-layer">
          {flightRoutes.map(({ route, routeKey, layers, eventKind, className }) => (
            <g key={route.id} data-route-parent={route.id}>
              <g
                key={`${routeKey}:connectors`}
                className={className}
                data-route-source={route.source.kind}
                data-event-kind={eventKind}
              >
                {layers
                  .filter(({ role }) => role !== 'tail')
                  .map((layer) => (
                    <path
                      key={layer.role}
                      className={`agent-event-bus__route-${layer.role}`}
                      d={route.path.d}
                      pathLength={route.path.length}
                      strokeDasharray={layer.dashArray}
                      strokeDashoffset={layer.startOffset}
                      data-route-animation={`${routeKey}:${layer.role}`}
                      data-animation-kind="flight"
                      data-pulse-role={layer.role}
                      data-route-length={route.path.length}
                      data-route-duration={route.path.durationMs}
                    />
                  ))}
              </g>
            </g>
          ))}
        </g>
        <g className="agent-event-bus__marker-layer">
          {ignitionRoutes
            .filter((route) => route.source.kind === 'agent')
            .map((route) => (
              <PulseMarker
                key={route.id}
                route={route}
                kind="ignition"
                x={route.path.source.x}
                y={route.path.source.y}
              />
            ))}
          {arrivedRoutes.map((route) => (
            <PulseMarker
              key={route.id}
              route={route}
              kind="arrival"
              x={route.path.recipient.x}
              y={route.path.recipient.y}
            />
          ))}
        </g>
      </svg>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="agent-event-bus__control-lane"
            tabIndex={0}
            aria-label="Agent event bus controls"
            onKeyDown={handleControlLaneKeyDown}
            data-testid="agent-event-bus-control-lane"
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuCheckboxItem
            checked={reduceMotion}
            onCheckedChange={handleReduceMotionChange}
          >
            Reduce motion
          </ContextMenuCheckboxItem>
        </ContextMenuContent>
      </ContextMenu>
    </AgentEventBusLayoutContext.Provider>
  );
}
