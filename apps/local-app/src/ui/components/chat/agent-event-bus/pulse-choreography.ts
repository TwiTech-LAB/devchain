export const EVENT_BUS_IGNITION_MS = 200;

export const EVENT_BUS_PULSE_ROLES = ['tail', 'body', 'head'] as const;

export type AgentEventBusPulseRole = (typeof EVENT_BUS_PULSE_ROLES)[number];

interface PulseRoleTiming {
  ignitionOpacity: number;
  cruisingOpacity: number;
  fadeStartProgress: number;
  fadeEndProgress: number;
}

export interface AgentEventBusPulseDescriptor {
  role: AgentEventBusPulseRole;
  segmentLength: number;
  dashGapLength: number;
  dashArray: string;
  startOffset: number;
  endOffset: number;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
}

export interface AgentEventBusPulseInterval {
  start: number;
  end: number;
}

/**
 * Every travelling layer is a zero-length dash. Combined with `stroke-linecap: round`
 * that renders as a perfect circle of the layer's stroke width, so the three layers
 * stack into one concentric point light instead of an elongated capsule. Radial
 * falloff therefore comes from stroke width + opacity (see `agent-event-bus.css`),
 * never from segment length.
 */
export const EVENT_BUS_PULSE_DOT_LENGTH = 0.01;

const ROLE_LENGTHS = {
  tail: EVENT_BUS_PULSE_DOT_LENGTH,
  body: EVENT_BUS_PULSE_DOT_LENGTH,
  head: EVENT_BUS_PULSE_DOT_LENGTH,
} as const satisfies Record<AgentEventBusPulseRole, number>;

const ROLE_TIMINGS = {
  // The bloom is blurred, which spreads its alpha over a much larger area, so it needs a
  // high base opacity to read as light at all. These are pre-blur values, not the
  // perceived brightness.
  tail: {
    ignitionOpacity: 0.95,
    cruisingOpacity: 0.85,
    fadeStartProgress: 0.86,
    fadeEndProgress: 0.97,
  },
  body: {
    ignitionOpacity: 0.8,
    cruisingOpacity: 0.7,
    fadeStartProgress: 0.92,
    fadeEndProgress: 0.99,
  },
  head: {
    ignitionOpacity: 1,
    cruisingOpacity: 1,
    fadeStartProgress: 1,
    fadeEndProgress: 1,
  },
} as const satisfies Record<AgentEventBusPulseRole, PulseRoleTiming>;

/**
 * Fraction of the flight spent accelerating away from the sender, and slowing into the
 * recipient. The span between them is travelled at a steady cruise.
 */
export const EVENT_BUS_FLIGHT_ACCELERATION = 0.28;
export const EVENT_BUS_FLIGHT_DECELERATION = 0.28;
/**
 * Positions sampled along the flight. The browser interpolates linearly between
 * keyframes, so this is how finely the velocity curve is approximated.
 */
export const EVENT_BUS_FLIGHT_SAMPLES = 24;

const HEAD_INITIAL_OPACITY = 0.82;

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * clampUnit(progress);
}

/**
 * Distance covered (0..1) at a given fraction of the flight time, under a trapezoidal
 * velocity profile: ramp up, hold, ramp down — the way a car covers ground between two
 * stops. Peak velocity is whatever makes the area under the curve exactly 1, so the
 * pulse still arrives precisely at the recipient at the end of its duration.
 *
 * The curve is baked into keyframe POSITIONS rather than applied as an effect easing,
 * so that time itself stays linear and the opacity staging below keeps its real-time
 * meaning (an eased effect would stretch the ignition bloom along with the motion).
 */
export function flightDistanceAtTime(
  timeProgress: number,
  accelerate = EVENT_BUS_FLIGHT_ACCELERATION,
  decelerate = EVENT_BUS_FLIGHT_DECELERATION,
): number {
  const time = clampUnit(timeProgress);
  const accel = Math.max(0, accelerate);
  const decel = Math.max(0, decelerate);
  const cruise = 1 - accel - decel;
  if (cruise < 0) return time;

  const peakVelocity = 1 / (1 - (accel + decel) / 2);
  if (time < accel) {
    return (peakVelocity * time * time) / (2 * accel);
  }
  const accelDistance = (peakVelocity * accel) / 2;
  if (time <= accel + cruise) {
    return accelDistance + peakVelocity * (time - accel);
  }
  const decelTime = time - accel - cruise;
  return clampUnit(
    accelDistance +
      peakVelocity * cruise +
      peakVelocity * decelTime -
      (peakVelocity * decelTime * decelTime) / (2 * decel),
  );
}

function offsetAtProgress(startOffset: number, pathLength: number, progress: number): number {
  return startOffset - pathLength * progress;
}

/**
 * Opacity is staged against two different clocks on purpose: the ignition bloom is a
 * fixed real-time beat after birth, while the fade back to a bare core is about being
 * near the recipient, which is a distance.
 */
function roleOpacityAt(
  role: AgentEventBusPulseRole,
  timeProgress: number,
  distance: number,
  ignitionTimeProgress: number,
  ignitionDistance: number,
): number {
  const timing = ROLE_TIMINGS[role];
  const initialOpacity = role === 'head' ? HEAD_INITIAL_OPACITY : 0;

  if (timeProgress < ignitionTimeProgress) {
    return lerp(initialOpacity, timing.ignitionOpacity, timeProgress / ignitionTimeProgress);
  }
  if (distance < timing.fadeStartProgress) {
    const span = timing.fadeStartProgress - ignitionDistance;
    return lerp(
      timing.ignitionOpacity,
      timing.cruisingOpacity,
      span <= 0 ? 1 : (distance - ignitionDistance) / span,
    );
  }
  if (distance < timing.fadeEndProgress) {
    const span = timing.fadeEndProgress - timing.fadeStartProgress;
    return lerp(
      timing.cruisingOpacity,
      0,
      span <= 0 ? 1 : (distance - timing.fadeStartProgress) / span,
    );
  }
  return timing.fadeEndProgress >= 1 ? timing.cruisingOpacity : 0;
}

function roleKeyframes(
  role: AgentEventBusPulseRole,
  startOffset: number,
  pathLength: number,
  ignitionProgress: number,
): Keyframe[] {
  const ignitionDistance = flightDistanceAtTime(ignitionProgress);
  const frames: Keyframe[] = [];

  // Sample on a uniform TIME grid; position follows the velocity curve. Sampling on a
  // distance grid instead would put the keyframes where the pulse is slow and leave the
  // fast cruise coarsely approximated.
  for (let sample = 0; sample <= EVENT_BUS_FLIGHT_SAMPLES; sample += 1) {
    const timeProgress = sample / EVENT_BUS_FLIGHT_SAMPLES;
    const distance = flightDistanceAtTime(timeProgress);
    frames.push({
      offset: timeProgress,
      strokeDashoffset: offsetAtProgress(startOffset, pathLength, distance),
      opacity: roleOpacityAt(role, timeProgress, distance, ignitionProgress, ignitionDistance),
    });
  }

  return frames;
}

export function isAgentEventBusPulseRole(
  value: string | undefined,
): value is AgentEventBusPulseRole {
  return EVENT_BUS_PULSE_ROLES.some((role) => role === value);
}

export function createAgentEventBusPulseChoreography(
  pathLengthInput: number,
  durationMsInput: number,
): AgentEventBusPulseDescriptor[] {
  const pathLength = Math.max(0, pathLengthInput);
  const durationMs = Math.max(1, durationMsInput);
  const ignitionProgress = Math.min(1, EVENT_BUS_IGNITION_MS / durationMs);

  return EVENT_BUS_PULSE_ROLES.map((role) => {
    const segmentLength = ROLE_LENGTHS[role];
    const dashGapLength = pathLength + segmentLength + 1;
    const dashPeriod = segmentLength + dashGapLength;
    const startOffset = dashPeriod + segmentLength;
    const endOffset = startOffset - pathLength;
    return {
      role,
      segmentLength,
      dashGapLength,
      dashArray: `${segmentLength} ${dashGapLength}`,
      startOffset,
      endOffset,
      keyframes: roleKeyframes(role, startOffset, pathLength, ignitionProgress),
      options: {
        duration: durationMs,
        easing: 'linear',
        fill: 'forwards',
      },
    };
  });
}

export function visibleAgentEventBusPulseIntervals(
  descriptor: AgentEventBusPulseDescriptor,
  pathLengthInput: number,
  progressInput: number,
): AgentEventBusPulseInterval[] {
  const pathLength = Math.max(0, pathLengthInput);
  const progress = Math.min(1, Math.max(0, progressInput));
  const [dashLength, dashGapLength] = descriptor.dashArray.split(' ').map(Number);
  const dashPeriod = dashLength + dashGapLength;
  const dashOffset = offsetAtProgress(descriptor.startOffset, pathLength, progress);
  const firstPatternIndex = Math.ceil((dashOffset - dashLength) / dashPeriod);
  const lastPatternIndex = Math.floor((pathLength + dashOffset) / dashPeriod);
  const intervals: AgentEventBusPulseInterval[] = [];

  for (let patternIndex = firstPatternIndex; patternIndex <= lastPatternIndex; patternIndex += 1) {
    const start = patternIndex * dashPeriod - dashOffset;
    const end = start + dashLength;
    if (end < 0 || start > pathLength) continue;
    intervals.push({
      start: Math.max(0, start),
      end: Math.min(pathLength, end),
    });
  }

  return intervals;
}

export const AGENT_EVENT_BUS_IGNITION_KEYFRAMES: Keyframe[] = [
  { offset: 0, opacity: 0, transform: 'scale(0.45)' },
  { offset: 0.28, opacity: 1, transform: 'scale(1)' },
  { offset: 0.7, opacity: 0.72, transform: 'scale(1.65)' },
  { offset: 1, opacity: 0, transform: 'scale(2.05)' },
];

export const AGENT_EVENT_BUS_IGNITION_OPTIONS: KeyframeAnimationOptions = {
  duration: EVENT_BUS_IGNITION_MS,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  fill: 'forwards',
};

export const AGENT_EVENT_BUS_ARRIVAL_KEYFRAMES: Keyframe[] = [
  { offset: 0, opacity: 0, transform: 'scale(0.5)' },
  { offset: 0.22, opacity: 1, transform: 'scale(1)' },
  { offset: 0.62, opacity: 0.68, transform: 'scale(1.7)' },
  { offset: 1, opacity: 0, transform: 'scale(2.1)' },
];

export const AGENT_EVENT_BUS_ARRIVAL_OPTIONS: KeyframeAnimationOptions = {
  duration: 240,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  fill: 'forwards',
};
