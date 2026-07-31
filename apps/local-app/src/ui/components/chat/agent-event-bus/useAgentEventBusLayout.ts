import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefCallback,
  type RefObject,
} from 'react';
import { DEFAULT_BUS_X, roundSvgCoordinate, RUNTIME_ORIGIN_Y } from './geometry';
import type {
  AgentEventBusAnchorDescriptor,
  AgentEventBusGeometrySnapshot,
  AgentEventBusLayoutApi,
} from './types';

interface RegisteredAnchor {
  descriptor: AgentEventBusAnchorDescriptor;
  element: HTMLElement;
  registrationOrder: number;
}

export interface AgentEventBusLayoutEnvironment {
  createResizeObserver: (callback: ResizeObserverCallback) => ResizeObserver;
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (handle: number) => void;
}

const DEFAULT_LAYOUT_ENVIRONMENT: AgentEventBusLayoutEnvironment = {
  createResizeObserver: (callback) => new ResizeObserver(callback),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
};

export interface UseAgentEventBusLayoutOptions {
  containerRef: RefObject<HTMLElement>;
  scopeEpoch: number;
  busX?: number;
  environment?: AgentEventBusLayoutEnvironment;
}

export interface UseAgentEventBusLayoutResult extends AgentEventBusLayoutApi {
  geometry: AgentEventBusGeometrySnapshot | null;
  requestMeasurement: () => void;
}

function compareDomOrder(left: RegisteredAnchor, right: RegisteredAnchor): number {
  if (left.element === right.element) return left.registrationOrder - right.registrationOrder;
  const position = left.element.compareDocumentPosition(right.element);
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return left.registrationOrder - right.registrationOrder;
}

export function useAgentEventBusLayout({
  containerRef,
  scopeEpoch,
  busX = DEFAULT_BUS_X,
  environment = DEFAULT_LAYOUT_ENVIRONMENT,
}: UseAgentEventBusLayoutOptions): UseAgentEventBusLayoutResult {
  const [geometry, setGeometry] = useState<AgentEventBusGeometrySnapshot | null>(null);
  const geometryRef = useRef<AgentEventBusGeometrySnapshot | null>(null);
  const registrationsRef = useRef(new Map<string, RegisteredAnchor>());
  const callbacksRef = useRef(
    new Map<
      string,
      {
        descriptor: AgentEventBusAnchorDescriptor;
        callback: RefCallback<HTMLElement>;
      }
    >(),
  );
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const animationFrameTokenRef = useRef(0);
  const geometryEpochRef = useRef(0);
  const scopeEpochRef = useRef(scopeEpoch);
  const registrationOrderRef = useRef(0);
  const orderedSignatureRef = useRef('');
  const mountedRef = useRef(true);

  const orderedRegistrations = useCallback(() => {
    return [...registrationsRef.current.values()].sort(compareDomOrder);
  }, []);

  const measure = useCallback(
    (frameToken: number) => {
      if (frameToken !== animationFrameTokenRef.current) return;
      animationFrameRef.current = null;
      const measurementScopeEpoch = scopeEpochRef.current;
      const measurementGeometryEpoch = geometryEpochRef.current;
      const container = containerRef.current;
      if (!container || !mountedRef.current) return;

      const containerRect = container.getBoundingClientRect();
      const registrations = orderedRegistrations();
      const anchors = registrations.map((registration, order) => {
        const rect = registration.element.getBoundingClientRect();
        return {
          ...registration.descriptor,
          x: roundSvgCoordinate(rect.left - containerRect.left),
          y: roundSvgCoordinate(rect.top - containerRect.top + rect.height / 2),
          order,
        };
      });
      const nextGeometry: AgentEventBusGeometrySnapshot = {
        scopeEpoch: measurementScopeEpoch,
        geometryEpoch: measurementGeometryEpoch,
        width: roundSvgCoordinate(containerRect.width),
        height: roundSvgCoordinate(containerRect.height),
        busX: roundSvgCoordinate(busX),
        runtimeOrigin: {
          kind: 'runtime',
          x: roundSvgCoordinate(busX),
          y: RUNTIME_ORIGIN_Y,
        },
        anchors,
      };

      if (
        !mountedRef.current ||
        scopeEpochRef.current !== measurementScopeEpoch ||
        geometryEpochRef.current !== measurementGeometryEpoch
      ) {
        return;
      }
      geometryRef.current = nextGeometry;
      setGeometry(nextGeometry);
    },
    [busX, containerRef, orderedRegistrations],
  );

  const requestMeasurement = useCallback(() => {
    geometryEpochRef.current += 1;
    if (animationFrameRef.current !== null) return;
    const frameToken = ++animationFrameTokenRef.current;
    animationFrameRef.current = environment.requestFrame(() => measure(frameToken));
  }, [environment, measure]);

  const refreshOrderedSignature = useCallback(
    (force = false) => {
      const signature = orderedRegistrations()
        .map((registration) => registration.descriptor.key)
        .join('|');
      if (!force && signature === orderedSignatureRef.current) return;
      orderedSignatureRef.current = signature;
      requestMeasurement();
    },
    [orderedRegistrations, requestMeasurement],
  );

  const getAnchorRef = useCallback(
    (descriptor: AgentEventBusAnchorDescriptor): RefCallback<HTMLElement> => {
      const cached = callbacksRef.current.get(descriptor.key);
      if (
        cached &&
        cached.descriptor.agentId === descriptor.agentId &&
        cached.descriptor.teamId === descriptor.teamId
      ) {
        return cached.callback;
      }

      const normalizedDescriptor = { ...descriptor };
      const callback: RefCallback<HTMLElement> = (element) => {
        const existing = registrationsRef.current.get(normalizedDescriptor.key);
        if (existing?.element && existing.element !== element) {
          resizeObserverRef.current?.unobserve(existing.element);
        }
        if (!element) {
          registrationsRef.current.delete(normalizedDescriptor.key);
          refreshOrderedSignature(true);
          return;
        }

        registrationsRef.current.set(normalizedDescriptor.key, {
          descriptor: normalizedDescriptor,
          element,
          registrationOrder: existing?.registrationOrder ?? registrationOrderRef.current++,
        });
        resizeObserverRef.current?.observe(element);
        refreshOrderedSignature(true);
      };
      callbacksRef.current.set(descriptor.key, {
        descriptor: normalizedDescriptor,
        callback,
      });
      return callback;
    },
    [refreshOrderedSignature],
  );

  useLayoutEffect(() => {
    mountedRef.current = true;
    const observerScopeEpoch = scopeEpoch;
    const observer = environment.createResizeObserver(() => {
      if (scopeEpochRef.current !== observerScopeEpoch) return;
      requestMeasurement();
    });
    resizeObserverRef.current = observer;
    const container = containerRef.current;
    if (container) observer.observe(container);
    for (const registration of registrationsRef.current.values()) {
      observer.observe(registration.element);
    }
    refreshOrderedSignature(true);

    return () => {
      resizeObserverRef.current = null;
      observer.disconnect();
    };
  }, [containerRef, environment, refreshOrderedSignature, requestMeasurement, scopeEpoch]);

  useLayoutEffect(() => {
    scopeEpochRef.current = scopeEpoch;
    geometryRef.current = null;
    setGeometry(null);
    if (animationFrameRef.current !== null) {
      environment.cancelFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    animationFrameTokenRef.current += 1;
    requestMeasurement();
  }, [environment, requestMeasurement, scopeEpoch]);

  useLayoutEffect(() => {
    return () => {
      mountedRef.current = false;
      if (animationFrameRef.current !== null) {
        environment.cancelFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      animationFrameTokenRef.current += 1;
    };
  }, [environment]);

  return useMemo(
    () => ({
      geometry,
      getAnchorRef,
      refreshRegistrationOrder: refreshOrderedSignature,
      requestMeasurement,
    }),
    [geometry, getAnchorRef, refreshOrderedSignature, requestMeasurement],
  );
}
