import {
  EVENT_BUS_PULSE_DOT_LENGTH,
  EVENT_BUS_PULSE_ROLES,
  createAgentEventBusPulseChoreography,
  flightDistanceAtTime,
  visibleAgentEventBusPulseIntervals,
} from './pulse-choreography';

// Layer: pure unit (Jest). Direct choreography math is the cheapest reliable
// proof of concentric dot geometry, opacity staging, and wrap safety.
describe('pulse choreography', () => {
  it('builds concentric zero-length dot layers sharing one leading edge', () => {
    const pathLength = 320;
    const descriptors = createAgentEventBusPulseChoreography(pathLength, 10_000);

    expect(descriptors.map(({ role }) => role)).toEqual(EVENT_BUS_PULSE_ROLES);
    // Every layer is the same zero-length dash: the point light's radial falloff comes
    // from stroke width, never from segment length. Unequal lengths would re-introduce
    // the elongated capsule this replaced.
    expect(descriptors.map(({ segmentLength }) => segmentLength)).toEqual(
      descriptors.map(() => EVENT_BUS_PULSE_DOT_LENGTH),
    );
    for (const descriptor of descriptors) {
      expect(descriptor.dashGapLength).toBeGreaterThan(pathLength);
      expect(descriptor.startOffset - descriptor.endOffset).toBe(pathLength);
      expect(descriptor.options).toEqual({
        duration: 10_000,
        easing: 'linear',
        fill: 'forwards',
      });
    }

    for (const progress of [0, 0.5, 1]) {
      for (const descriptor of descriptors) {
        const [interval] = visibleAgentEventBusPulseIntervals(descriptor, pathLength, progress);
        expect(interval.end).toBeCloseTo(pathLength * progress, 6);
      }
    }
  });

  it.each([
    [32, 7_000],
    [320, 10_000],
    [868, 14_000],
  ])('keeps exactly one non-wrapping dot across a %spx / %sms route', (pathLength, durationMs) => {
    const descriptors = createAgentEventBusPulseChoreography(pathLength, durationMs);
    for (const descriptor of descriptors) {
      for (const progress of [0, 0.5, 1]) {
        const intervals = visibleAgentEventBusPulseIntervals(descriptor, pathLength, progress);

        expect(intervals).toHaveLength(1);
        expect(intervals[0].end).toBeCloseTo(pathLength * progress, 6);
        // A dot, not a streak: the visible run never exceeds the dash length.
        expect(intervals[0].end - intervals[0].start).toBeLessThanOrEqual(
          EVENT_BUS_PULSE_DOT_LENGTH + 1e-9,
        );
      }
    }
  });

  it('blooms body and tail during ignition, then contracts tail before body and leaves the core', () => {
    const [tail, body, head] = createAgentEventBusPulseChoreography(320, 7_000);
    const opacities = (descriptor: { keyframes: Keyframe[] }) =>
      descriptor.keyframes.map((frame) => Number(frame.opacity));
    const firstZeroIndex = (values: number[]) =>
      values.findIndex((value, index) => index > 0 && value === 0);

    const tailOpacity = opacities(tail);
    const bodyOpacity = opacities(body);
    const headOpacity = opacities(head);

    // Bloom and glow are born dark and ramp up; the core is lit from the first frame.
    expect(tailOpacity[0]).toBe(0);
    expect(bodyOpacity[0]).toBe(0);
    expect(headOpacity[0]).toBeGreaterThan(0);
    expect(Math.max(...tailOpacity)).toBeGreaterThan(0.9);
    expect(Math.max(...bodyOpacity)).toBeGreaterThan(0.75);

    // Outer bloom collapses first, inner glow second, so the pulse contracts back to the
    // bright core before the arrival flash.
    expect(firstZeroIndex(tailOpacity)).toBeGreaterThan(0);
    expect(firstZeroIndex(tailOpacity)).toBeLessThan(firstZeroIndex(bodyOpacity));
    expect(tailOpacity.at(-1)).toBe(0);
    expect(bodyOpacity.at(-1)).toBe(0);
    expect(headOpacity.at(-1)).toBe(1);
  });

  it('accelerates away, cruises, then decelerates into the recipient', () => {
    const samples = Array.from({ length: 101 }, (_, index) => flightDistanceAtTime(index / 100));

    // Starts at the sender, lands exactly on the recipient, never reverses.
    expect(flightDistanceAtTime(0)).toBe(0);
    expect(flightDistanceAtTime(1)).toBeCloseTo(1, 10);
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]).toBeGreaterThanOrEqual(samples[index - 1]);
    }

    // Behind a constant-speed run in the first half, ahead of it in the second, and
    // symmetric about the midpoint.
    expect(flightDistanceAtTime(0.2)).toBeLessThan(0.2);
    expect(flightDistanceAtTime(0.8)).toBeGreaterThan(0.8);
    expect(flightDistanceAtTime(0.5)).toBeCloseTo(0.5, 10);

    // Cruise is genuinely faster than the ramps at either end.
    const stepAt = (time: number) => flightDistanceAtTime(time + 0.05) - flightDistanceAtTime(time);
    expect(stepAt(0.5)).toBeGreaterThan(stepAt(0));
    expect(stepAt(0.5)).toBeGreaterThan(stepAt(0.95));
  });
});
